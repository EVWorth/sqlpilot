use crate::backup::escape::{format_cell, shape_of, CellShape};
use crate::connection::ConnectionManager;
use crate::error::CoreError;
use crate::schema::ident::{qualified, quote_ident};
use crate::schema::SchemaInspector;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, Column, Row, TypeInfo};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncWriteExt, BufWriter};

/// How much is written before the buffer goes to the file. Bigger buffers buy
/// little once the syscall is amortised, and every byte of it is resident.
const WRITE_BUFFER_BYTES: usize = 256 * 1024;

/// The shortest gap between two progress reports.
///
/// Progress used to be emitted once per table, so a single large table showed
/// nothing at all from start to finish (#361). Emitting per row would spend
/// more time on IPC than on the dump.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupOptions {
    pub include_structure: bool,
    pub include_data: bool,
    pub drop_table_if_exists: bool,
    pub include_create_database: bool,
    pub add_table_locks: bool,
    pub include_auto_increment: bool,
    pub include_views: bool,
    pub include_routines: bool,
    pub include_triggers: bool,
    /// Many rows per INSERT. Far smaller and far faster to restore; one row
    /// per INSERT is what you want when the file is going to be edited or
    /// diffed.
    pub multi_row_inserts: bool,
    pub insert_batch_size: u32,
    /// Read every table inside one transaction, so the dump is the database
    /// as it was at one instant.
    ///
    /// What `mysqldump --single-transaction` does. Without it a dump of a
    /// live database can contain a parent row written after the child row
    /// that references it — a file that will not restore. InnoDB only; the
    /// server says so and the dump records that it could not.
    pub consistent_snapshot: bool,
}

impl Default for BackupOptions {
    fn default() -> Self {
        Self {
            include_structure: true,
            include_data: true,
            drop_table_if_exists: true,
            include_create_database: false,
            add_table_locks: false,
            include_auto_increment: true,
            include_views: true,
            include_routines: true,
            include_triggers: true,
            multi_row_inserts: true,
            insert_batch_size: 100,
            consistent_snapshot: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub phase: String,
    pub current_table: u32,
    pub total_tables: u32,
    pub table_name: String,
    #[specta(type = specta_typescript::Number)]
    pub rows_exported: u64,
    #[specta(type = specta_typescript::Number)]
    pub bytes_written: u64,
    #[specta(type = specta_typescript::Number)]
    pub elapsed_ms: u64,
    /// Rows a second over the last interval, not since the start — a rate
    /// averaged over an hour tells you nothing about the table being read now.
    pub rows_per_second: f64,
    /// The server's estimate of how many rows this table has, when it has one.
    /// `information_schema` rather than `COUNT(*)`: counting every row of
    /// every table before dumping them doubles the work to draw a bar.
    #[specta(type = Option<specta_typescript::Number>)]
    pub estimated_rows: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    #[specta(type = specta_typescript::Number)]
    pub bytes_written: u64,
    #[specta(type = specta_typescript::Number)]
    pub rows_exported: u64,
    pub tables: u32,
    #[specta(type = specta_typescript::Number)]
    pub elapsed_ms: u64,
    /// True when the user stopped it. The partial file is removed, so there
    /// is nothing left that could be mistaken for a backup.
    pub cancelled: bool,
    /// What went wrong that did not stop the dump — a view whose definer is
    /// gone, a table the snapshot could not cover. Each one is also a comment
    /// in the file, but the caller should not have to read the file to learn
    /// that something is missing from it.
    pub warnings: Vec<String>,
}

/// Dump `tables` (and optionally the database's views, routines and triggers)
/// to `output_path`.
///
/// Everything is written as it is read. The only thing held in memory is the
/// write buffer and the row being formatted.
#[allow(clippy::too_many_arguments)]
pub async fn run_backup(
    manager: Arc<ConnectionManager>,
    connection_id: &str,
    database: &str,
    tables: &[String],
    options: &BackupOptions,
    output_path: &std::path::Path,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(BackupProgress),
) -> Result<BackupSummary, CoreError> {
    let started = Instant::now();
    let pool = manager.get_pool(connection_id)?;
    let inspector = SchemaInspector::new(manager.clone());

    // One connection for the whole dump. The pool would spread the reads over
    // several sessions, which makes a consistent snapshot impossible and
    // makes `LOCK TABLES` apply to a session that is not doing the reading.
    let mut conn = pool
        .acquire()
        .await
        .map_err(|e| CoreError::Connection(format!("Could not start the backup: {e}")))?;

    let mut warnings: Vec<String> = Vec::new();

    let file = tokio::fs::File::create(output_path).await.map_err(|e| {
        CoreError::Storage(format!("Could not write to {}: {e}", output_path.display()))
    })?;
    let bytes = Arc::new(AtomicU64::new(0));
    let mut out = Sink::new(
        BufWriter::with_capacity(WRITE_BUFFER_BYTES, file),
        bytes.clone(),
    );

    let mut state = Progress::new(tables.len() as u32, bytes.clone());

    let mut snapshot_open = false;
    let result = dump(
        &mut out,
        &mut conn,
        &inspector,
        connection_id,
        database,
        tables,
        options,
        &cancel,
        &mut state,
        &mut on_progress,
        &mut warnings,
        &mut snapshot_open,
    )
    .await;

    // End the snapshot transaction before the connection goes back to the
    // pool. Leaving it open hands the next caller a session still reading the
    // database as it was — which shows up later, somewhere else, as
    // "Table definition has changed, please retry transaction".
    if snapshot_open {
        let _ = sqlx::raw_sql(AssertSqlSafe("COMMIT".to_string()))
            .execute(&mut *conn)
            .await;
    }

    // Flush before deciding anything: a file left half-written by a failed
    // flush is worse than the error that caused it.
    let flushed = out.finish().await;
    let cancelled = cancel.load(Ordering::Relaxed);

    if let Err(e) = result {
        let _ = tokio::fs::remove_file(output_path).await;
        return Err(e);
    }
    flushed?;

    if cancelled {
        // A partial dump that looks like a dump is how someone restores half
        // a database a month later. Cancelling leaves nothing behind.
        tokio::fs::remove_file(output_path).await.map_err(|e| {
            CoreError::Storage(format!("Cancelled, but the partial file remains: {e}"))
        })?;
    }

    Ok(BackupSummary {
        bytes_written: bytes.load(Ordering::Relaxed),
        rows_exported: state.rows,
        tables: state.tables_done,
        elapsed_ms: started.elapsed().as_millis() as u64,
        cancelled,
        warnings,
    })
}

#[allow(clippy::too_many_arguments)]
async fn dump(
    out: &mut Sink,
    conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
    inspector: &SchemaInspector,
    connection_id: &str,
    database: &str,
    tables: &[String],
    options: &BackupOptions,
    cancel: &AtomicBool,
    state: &mut Progress,
    on_progress: &mut impl FnMut(BackupProgress),
    warnings: &mut Vec<String>,
    snapshot_open: &mut bool,
) -> Result<(), CoreError> {
    write_header(out, database, options).await?;

    if options.consistent_snapshot && options.include_data {
        match sqlx::raw_sql(AssertSqlSafe(
            "START TRANSACTION WITH CONSISTENT SNAPSHOT".to_string(),
        ))
        .execute(&mut **conn)
        .await
        {
            Ok(_) => {
                *snapshot_open = true;
                out.write("-- Read from a single consistent snapshot.\n\n")
                    .await?
            }
            Err(e) => {
                // MyISAM, or a server that will not give one. Say so in the
                // file: a dump of a live database taken without one can hold
                // a child row whose parent is not there.
                let note = format!(
                    "Could not take a consistent snapshot ({e}); tables were read one after another, \
                     so a database being written to during the dump may be internally inconsistent"
                );
                out.write(&format!("-- WARNING: {note}\n\n")).await?;
                warnings.push(note);
            }
        }
    }

    for (index, table) in tables.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        state.current_table = index as u32 + 1;
        state.table_name = table.clone();
        state.phase = "Backing up tables".to_string();
        state.estimated_rows = estimate_rows(conn, database, table).await;
        state.emit(on_progress, true);

        out.write(&format!("--\n-- Table: {}\n--\n\n", quote_ident(table)))
            .await?;

        if options.include_structure {
            if options.drop_table_if_exists {
                out.write(&format!("DROP TABLE IF EXISTS {};\n", quote_ident(table)))
                    .await?;
            }
            let mut ddl = inspector
                .get_table_ddl(connection_id, database, table)
                .await?;
            if !options.include_auto_increment {
                ddl = strip_auto_increment(&ddl);
            }
            out.write(&format!("{ddl};\n\n")).await?;
        }

        if options.include_data {
            if options.add_table_locks {
                out.write(&format!("LOCK TABLES {} WRITE;\n", quote_ident(table)))
                    .await?;
            }
            dump_rows(
                out,
                conn,
                database,
                table,
                options,
                cancel,
                state,
                on_progress,
            )
            .await?;
            if options.add_table_locks {
                out.write("UNLOCK TABLES;\n").await?;
            }
            out.write("\n").await?;
        }

        state.tables_done += 1;
    }

    if options.include_views && !cancel.load(Ordering::Relaxed) {
        dump_views(
            out,
            inspector,
            connection_id,
            database,
            options,
            cancel,
            state,
            on_progress,
            warnings,
        )
        .await?;
    }
    if options.include_routines && !cancel.load(Ordering::Relaxed) {
        dump_routines(
            out,
            inspector,
            connection_id,
            database,
            cancel,
            state,
            on_progress,
            warnings,
        )
        .await?;
    }
    if options.include_triggers && !cancel.load(Ordering::Relaxed) {
        dump_triggers(
            out,
            inspector,
            connection_id,
            database,
            cancel,
            state,
            on_progress,
            warnings,
        )
        .await?;
    }

    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }
    write_footer(out).await
}

/// Stream one table's rows straight into the file.
#[allow(clippy::too_many_arguments)]
async fn dump_rows(
    out: &mut Sink,
    conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
    database: &str,
    table: &str,
    options: &BackupOptions,
    cancel: &AtomicBool,
    state: &mut Progress,
    on_progress: &mut impl FnMut(BackupProgress),
) -> Result<(), CoreError> {
    // No LIMIT, no OFFSET. Paging a table with neither an ORDER BY nor a
    // stable session is free to repeat a row or skip one, and costs the
    // server a fresh scan for every page (#358).
    let select = format!("SELECT * FROM {}", qualified(database, table));
    let mut stream = sqlx::raw_sql(AssertSqlSafe(select)).fetch(&mut **conn);

    let batch_size = options.insert_batch_size.max(1) as usize;
    // Held across rows: the column names and shapes, and the rows of the
    // INSERT being built. Never the table.
    let mut prefix: Option<String> = None;
    let mut shapes: Vec<CellShape> = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let mut pending_bytes = 0usize;

    while let Some(row) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let row = row.map_err(|e| CoreError::Query(format!("Reading {table}: {e}")))?;

        if prefix.is_none() {
            let names: Vec<String> = row
                .columns()
                .iter()
                .map(|c| quote_ident(c.name()))
                .collect();
            shapes = row
                .columns()
                .iter()
                .map(|c| shape_of(c.type_info().name()))
                .collect();
            prefix = Some(format!(
                "INSERT INTO {} ({}) VALUES",
                quote_ident(table),
                names.join(", ")
            ));
        }

        let mut values = String::new();
        values.push('(');
        for (index, _) in row.columns().iter().enumerate() {
            if index > 0 {
                values.push_str(", ");
            }
            // Unchecked because the point is to take the bytes the server
            // printed, whatever the column's declared type: a checked decode
            // into `&[u8]` refuses anything sqlx does not consider binary,
            // and going through a typed decode is what used to round DECIMAL
            // through f64 and truncate DATETIME to whole seconds.
            let bytes: Option<&[u8]> = row
                .try_get_unchecked(index)
                .map_err(|e| CoreError::Query(format!("Reading column {index} of {table}: {e}")))?;
            values.push_str(&format_cell(bytes, shapes[index]));
        }
        values.push(')');

        pending_bytes += values.len();
        pending.push(values);
        state.rows += 1;

        let full = pending.len()
            >= if options.multi_row_inserts {
                batch_size
            } else {
                1
            };
        // A row can be a megabyte on its own. Batching by count alone would
        // build a statement no server would accept.
        let large = pending_bytes >= 4 * 1024 * 1024;
        if full || large {
            flush_insert(out, prefix.as_deref(), &mut pending, &mut pending_bytes).await?;
            state.emit(on_progress, false);
        }
    }

    // The stream borrows the connection until it is gone.
    drop(stream);
    flush_insert(out, prefix.as_deref(), &mut pending, &mut pending_bytes).await?;
    state.emit(on_progress, true);
    Ok(())
}

async fn flush_insert(
    out: &mut Sink,
    prefix: Option<&str>,
    pending: &mut Vec<String>,
    pending_bytes: &mut usize,
) -> Result<(), CoreError> {
    if pending.is_empty() {
        return Ok(());
    }
    let prefix = prefix.unwrap_or_default();
    out.write(&format!("{prefix}\n{};\n", pending.join(",\n")))
        .await?;
    pending.clear();
    *pending_bytes = 0;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn dump_views(
    out: &mut Sink,
    inspector: &SchemaInspector,
    connection_id: &str,
    database: &str,
    options: &BackupOptions,
    cancel: &AtomicBool,
    state: &mut Progress,
    on_progress: &mut impl FnMut(BackupProgress),
    warnings: &mut Vec<String>,
) -> Result<(), CoreError> {
    let views = inspector.get_views(connection_id, database).await?;
    if views.is_empty() {
        return Ok(());
    }
    out.write("--\n-- Views\n--\n\n").await?;
    state.phase = "Backing up views".to_string();

    for view in views {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        state.table_name = view.name.clone();
        state.emit(on_progress, true);

        match inspector
            .get_view_ddl(connection_id, database, &view.name)
            .await
        {
            Ok(ddl) => {
                let ddl = unqualify(&ddl, database);
                if options.drop_table_if_exists {
                    out.write(&format!(
                        "DROP VIEW IF EXISTS {};\n",
                        quote_ident(&view.name)
                    ))
                    .await?;
                }
                out.write(&format!("{ddl};\n\n")).await?;
            }
            Err(e) => note_skipped(out, warnings, "view", &view.name, &e.to_string()).await?,
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn dump_routines(
    out: &mut Sink,
    inspector: &SchemaInspector,
    connection_id: &str,
    database: &str,
    cancel: &AtomicBool,
    state: &mut Progress,
    on_progress: &mut impl FnMut(BackupProgress),
    warnings: &mut Vec<String>,
) -> Result<(), CoreError> {
    let routines = inspector.get_routines(connection_id, database).await?;
    if routines.is_empty() {
        return Ok(());
    }
    out.write("--\n-- Routines\n--\n\n").await?;
    state.phase = "Backing up routines".to_string();

    for routine in routines {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        state.table_name = routine.name.clone();
        state.emit(on_progress, true);

        let kind = if routine.routine_type.eq_ignore_ascii_case("FUNCTION") {
            "FUNCTION"
        } else {
            "PROCEDURE"
        };
        match inspector
            .get_routine_ddl(
                connection_id,
                database,
                &routine.name,
                &routine.routine_type,
            )
            .await
        {
            Ok(ddl) => {
                out.write(&format!(
                    "DROP {kind} IF EXISTS {};\nDELIMITER ;;\n{ddl} ;;\nDELIMITER ;\n\n",
                    quote_ident(&routine.name)
                ))
                .await?;
            }
            Err(e) => note_skipped(out, warnings, "routine", &routine.name, &e.to_string()).await?,
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn dump_triggers(
    out: &mut Sink,
    inspector: &SchemaInspector,
    connection_id: &str,
    database: &str,
    cancel: &AtomicBool,
    state: &mut Progress,
    on_progress: &mut impl FnMut(BackupProgress),
    warnings: &mut Vec<String>,
) -> Result<(), CoreError> {
    let triggers = inspector.get_triggers(connection_id, database).await?;
    if triggers.is_empty() {
        return Ok(());
    }
    out.write("--\n-- Triggers\n--\n\n").await?;
    state.phase = "Backing up triggers".to_string();

    for trigger in triggers {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        state.table_name = trigger.name.clone();
        state.emit(on_progress, true);

        match inspector
            .get_trigger_ddl(connection_id, database, &trigger.name)
            .await
        {
            Ok(ddl) => {
                out.write(&format!(
                    "DROP TRIGGER IF EXISTS {};\nDELIMITER ;;\n{ddl} ;;\nDELIMITER ;\n\n",
                    quote_ident(&trigger.name)
                ))
                .await?;
            }
            Err(e) => note_skipped(out, warnings, "trigger", &trigger.name, &e.to_string()).await?,
        }
    }
    Ok(())
}

/// Remove `` `db`. `` from a definition, so it restores where it is loaded.
///
/// `SHOW CREATE VIEW` names the view — and every table in its body — with the
/// database it came from. Restoring such a dump into a second database
/// recreates the view in the *first* one, or fails with "already exists"
/// against the object it was copied from. Triggers and routines come back
/// unqualified, so this applies only to views. mysqldump's output is
/// unqualified for the same reason.
fn unqualify(ddl: &str, database: &str) -> String {
    ddl.replace(&format!("{}.", quote_ident(database)), "")
}

/// Record that one object could not be read, in the file and to the caller.
///
/// A view whose definer no longer exists is the ordinary case, and it should
/// not cost the user the other nine hundred tables. It must not pass silently
/// either: the file would be missing something with nothing to say so.
async fn note_skipped(
    out: &mut Sink,
    warnings: &mut Vec<String>,
    kind: &str,
    name: &str,
    error: &str,
) -> Result<(), CoreError> {
    let note = format!("Skipped {kind} {name}: {error}");
    out.write(&format!("-- WARNING: {note}\n\n")).await?;
    warnings.push(note);
    Ok(())
}

/// The server's row estimate, for a progress bar. None when it has none.
async fn estimate_rows(
    conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
    database: &str,
    table: &str,
) -> Option<u64> {
    // BIGINT UNSIGNED. Decoding it as i64 fails, and the failure was silent:
    // every progress report came back with no estimate at all.
    sqlx::query_scalar::<_, Option<u64>>(
        "SELECT TABLE_ROWS FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    )
    .bind(database)
    .bind(table)
    .fetch_optional(&mut **conn)
    .await
    .ok()
    .flatten()
    .flatten()
}

/// Remove the `AUTO_INCREMENT=` clause from a CREATE TABLE.
///
/// Only the table-level one: a column's `AUTO_INCREMENT` keyword carries no
/// `=`, so matching on the assignment leaves the column definition alone.
fn strip_auto_increment(ddl: &str) -> String {
    let mut out = String::with_capacity(ddl.len());
    let bytes = ddl.as_bytes();
    let needle = b"AUTO_INCREMENT=";
    let mut i = 0;
    while i < bytes.len() {
        let matches = bytes.len() - i >= needle.len()
            && bytes[i..i + needle.len()].eq_ignore_ascii_case(needle);
        if matches {
            // Take the space before it too, so `ENGINE=InnoDB AUTO_INCREMENT=5
            // DEFAULT` does not become a double space.
            while out.ends_with(' ') {
                out.pop();
            }
            i += needle.len();
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

async fn write_header(
    out: &mut Sink,
    database: &str,
    options: &BackupOptions,
) -> Result<(), CoreError> {
    let now = chrono::Utc::now().to_rfc3339();
    out.write(&format!(
        "-- SQLPilot Database Backup\n-- Generated: {now}\n-- Database: {database}\n\n"
    ))
    .await?;

    // The version-gated forms, so the file is also readable by mysql(1) and
    // by servers that do not know one of these.
    for line in [
        "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;",
        "/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;",
        "/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;",
        "/*!40101 SET NAMES utf8mb4 */;",
        "/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;",
        "/*!40103 SET TIME_ZONE='+00:00' */;",
        "/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;",
        "/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;",
        "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
        "/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;",
    ] {
        out.write(line).await?;
        out.write("\n").await?;
    }
    out.write("\n").await?;

    if options.include_create_database {
        out.write(&format!(
            "CREATE DATABASE IF NOT EXISTS {};\nUSE {};\n\n",
            quote_ident(database),
            quote_ident(database)
        ))
        .await?;
    }
    Ok(())
}

async fn write_footer(out: &mut Sink) -> Result<(), CoreError> {
    for line in [
        "/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;",
        "/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;",
        "/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;",
        "/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;",
        "/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;",
        "/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;",
        "/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;",
        "/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;",
    ] {
        out.write(line).await?;
        out.write("\n").await?;
    }
    // The marker that says the dump finished. A file without it was
    // interrupted, whatever its size.
    out.write(&format!(
        "\n-- Backup completed: {}\n",
        chrono::Utc::now().to_rfc3339()
    ))
    .await
}

/// The file, plus the byte count the progress reports need.
struct Sink {
    inner: BufWriter<tokio::fs::File>,
    /// Shared with the progress reporter, which is the only other thing that
    /// needs to know how much has been written and must not have its own
    /// count to drift from this one.
    bytes: Arc<AtomicU64>,
}

impl Sink {
    fn new(inner: BufWriter<tokio::fs::File>, bytes: Arc<AtomicU64>) -> Self {
        Self { inner, bytes }
    }

    async fn write(&mut self, text: &str) -> Result<(), CoreError> {
        self.inner
            .write_all(text.as_bytes())
            .await
            .map_err(|e| CoreError::Storage(format!("Writing the backup failed: {e}")))?;
        self.bytes.fetch_add(text.len() as u64, Ordering::Relaxed);
        Ok(())
    }

    /// Flush and close. A buffered write that fails at flush time is still a
    /// failed backup, so this is checked rather than dropped.
    async fn finish(mut self) -> Result<(), CoreError> {
        self.inner
            .flush()
            .await
            .map_err(|e| CoreError::Storage(format!("Writing the backup failed: {e}")))?;
        self.inner
            .into_inner()
            .sync_all()
            .await
            .map_err(|e| CoreError::Storage(format!("The backup did not reach the disk: {e}")))
    }
}

/// Where the dump has got to, and how fast.
struct Progress {
    phase: String,
    current_table: u32,
    total_tables: u32,
    table_name: String,
    tables_done: u32,
    rows: u64,
    estimated_rows: Option<u64>,
    bytes: Arc<AtomicU64>,
    started: Instant,
    last_emit: Instant,
    rows_at_last_emit: u64,
}

impl Progress {
    fn new(total_tables: u32, bytes: Arc<AtomicU64>) -> Self {
        let now = Instant::now();
        Self {
            phase: "Starting".to_string(),
            current_table: 0,
            total_tables,
            table_name: String::new(),
            tables_done: 0,
            rows: 0,
            bytes,
            estimated_rows: None,
            started: now,
            last_emit: now,
            rows_at_last_emit: 0,
        }
    }

    /// Report, unless the last report was moments ago.
    ///
    /// `force` is for the boundaries — a new table, the end of one — which
    /// should always be shown even when they arrive quickly.
    fn emit(&mut self, on_progress: &mut impl FnMut(BackupProgress), force: bool) {
        let since = self.last_emit.elapsed();
        if !force && since < PROGRESS_INTERVAL {
            return;
        }
        let rows_per_second = if since.as_secs_f64() > 0.0 {
            (self.rows - self.rows_at_last_emit) as f64 / since.as_secs_f64()
        } else {
            0.0
        };
        self.last_emit = Instant::now();
        self.rows_at_last_emit = self.rows;

        on_progress(BackupProgress {
            phase: self.phase.clone(),
            current_table: self.current_table,
            total_tables: self.total_tables,
            table_name: self.table_name.clone(),
            rows_exported: self.rows,
            bytes_written: self.bytes.load(Ordering::Relaxed),
            elapsed_ms: self.started.elapsed().as_millis() as u64,
            rows_per_second,
            estimated_rows: self.estimated_rows,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_level_auto_increment_is_removed() {
        let ddl = "CREATE TABLE `t` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4";
        let stripped = strip_auto_increment(ddl);
        assert!(!stripped.contains("AUTO_INCREMENT=42"));
        // The column keyword must survive: without it the restored table has
        // no auto-incrementing key at all.
        assert!(stripped.contains("`id` int NOT NULL AUTO_INCREMENT,"));
        assert!(stripped.contains("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"));
    }

    #[test]
    fn a_ddl_without_one_is_unchanged() {
        let ddl = "CREATE TABLE `t` (`a` int) ENGINE=InnoDB";
        assert_eq!(strip_auto_increment(ddl), ddl);
    }

    #[test]
    fn a_views_definition_is_stripped_of_the_database_it_came_from() {
        // SHOW CREATE VIEW names the view and every table in its body with
        // the source database. Restoring that into a second database
        // recreates the view in the first one.
        let ddl = "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER                    VIEW `shop`.`a_view` AS select `shop`.`orders`.`id` AS `id` from `shop`.`orders`";
        let out = unqualify(ddl, "shop");
        assert!(!out.contains("`shop`."), "still qualified: {out}");
        assert!(out.contains("VIEW `a_view` AS"));
        assert!(out.contains("from `orders`"));
    }

    #[test]
    fn a_database_whose_name_is_a_substring_of_another_is_left_alone() {
        // Backticks make the match exact, which is why the replacement is of
        // the quoted form rather than the bare name.
        let ddl = "VIEW `v` AS select * from `shopping`.`t`";
        assert_eq!(unqualify(ddl, "shop"), ddl);
    }

    #[test]
    fn the_options_default_to_a_consistent_snapshot() {
        // A dump of a live database taken without one can contain a child row
        // whose parent is missing, which will not restore.
        assert!(BackupOptions::default().consistent_snapshot);
    }
}
