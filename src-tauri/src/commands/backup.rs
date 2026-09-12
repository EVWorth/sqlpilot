use mas_core::backup::{run_backup, BackupOptions, BackupProgress, BackupSummary};
use mas_core::restore::{run_restore, RestoreOptions, RestoreProgress, RestoreSummary};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, State};

use super::AppState;

/// Where a backup has got to.
///
/// A typed event rather than a bare `emit`, so the listener in the dialog and
/// the payload sent here are generated from one definition and cannot drift.
/// The id is on the event because two backups can run at once — the dialog
/// must not draw another window's progress.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgressEvent {
    pub backup_id: String,
    pub progress: BackupProgress,
}

/// The flag each running backup watches, by the id the caller chose.
///
/// A backup is a long call that has to be interruptible from a second call —
/// the dialog's Cancel button — so the flag cannot live in the future doing
/// the work. Entries are removed when the backup ends, however it ends.
fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Removes this backup's flag however the call ends, including on an error
/// path that returns early.
struct Registration(String);

impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut map) = running().lock() {
            map.remove(&self.0);
        }
    }
}

/// Write a database to a SQL file, streaming as it reads.
///
/// Progress arrives as `backup:progress` events rather than as a return
/// value, since the point is to show it while the call is still running.
#[tauri::command]
#[tracing::instrument(skip(state, app, options), fields(table_count = tables.len()))]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn backup_database(
    state: State<'_, AppState>,
    app: AppHandle,
    backup_id: String,
    connection_id: String,
    database: String,
    tables: Vec<String>,
    options: BackupOptions,
    output_path: String,
) -> Result<BackupSummary, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = running()
            .lock()
            .map_err(|_| "The backup registry is poisoned".to_string())?;
        if map.contains_key(&backup_id) {
            return Err(format!("A backup with id {backup_id} is already running"));
        }
        map.insert(backup_id.clone(), cancel.clone());
    }
    let _registration = Registration(backup_id.clone());

    let emit_handle = app.clone();
    let emit_id = backup_id.clone();
    use tauri_specta::Event as _;
    let summary = run_backup(
        state.connection_manager.clone(),
        &connection_id,
        &database,
        &tables,
        &options,
        &PathBuf::from(&output_path),
        cancel,
        move |progress| {
            // A failed emit is not a reason to abandon a dump that is
            // otherwise going fine; the next one will land.
            let event = BackupProgressEvent {
                backup_id: emit_id.clone(),
                progress,
            };
            if let Err(e) = event.emit(&emit_handle) {
                tracing::warn!(error = %e, "Could not emit backup progress");
            }
        },
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, database = %database, "Backup failed");
        e.to_string()
    })?;

    tracing::info!(
        database = %database,
        bytes = summary.bytes_written,
        rows = summary.rows_exported,
        cancelled = summary.cancelled,
        "Backup finished"
    );
    Ok(summary)
}

/// Where a restore has got to.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct RestoreProgressEvent {
    pub restore_id: String,
    pub progress: RestoreProgress,
}

/// Run a SQL dump into a database, streaming the file.
///
/// The renderer used to read the whole file, split it, and send back one
/// statement per call — each on whichever pooled connection it landed on, so
/// `USE` and any session setting applied to a session the next statement
/// might not get.
#[tauri::command]
#[tracing::instrument(skip(state, app, options))]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn restore_database(
    state: State<'_, AppState>,
    app: AppHandle,
    restore_id: String,
    connection_id: String,
    database: String,
    input_path: String,
    options: RestoreOptions,
) -> Result<RestoreSummary, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = running()
            .lock()
            .map_err(|_| "The backup registry is poisoned".to_string())?;
        if map.contains_key(&restore_id) {
            return Err(format!("A job with id {restore_id} is already running"));
        }
        map.insert(restore_id.clone(), cancel.clone());
    }
    let _registration = Registration(restore_id.clone());

    let emit_handle = app.clone();
    let emit_id = restore_id.clone();
    use tauri_specta::Event as _;
    let summary = run_restore(
        state.connection_manager.clone(),
        &connection_id,
        &database,
        &PathBuf::from(&input_path),
        &options,
        cancel,
        move |progress| {
            let event = RestoreProgressEvent {
                restore_id: emit_id.clone(),
                progress,
            };
            if let Err(e) = event.emit(&emit_handle) {
                tracing::warn!(error = %e, "Could not emit restore progress");
            }
        },
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, database = %database, "Restore failed");
        e.to_string()
    })?;

    tracing::info!(
        database = %database,
        statements = summary.statements_run,
        failed = summary.statements_failed,
        "Restore finished"
    );
    Ok(summary)
}

/// The first part of a file, for a preview, with the whole file's size.
///
/// `read_file_contents` reads all of it, which for a dump means holding a
/// multi-gigabyte string in the renderer to draw thirty lines of preview.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileHead {
    pub text: String,
    #[specta(type = specta_typescript::Number)]
    pub total_bytes: u64,
    /// True when the file is longer than what was read.
    pub truncated: bool,
}

#[tauri::command]
#[tracing::instrument]
#[specta::specta]
pub async fn read_file_head(path: String, max_bytes: u32) -> Result<FileHead, String> {
    use tokio::io::AsyncReadExt;

    let total_bytes = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Could not read {path}: {e}"))?
        .len();

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("Could not read {path}: {e}"))?;
    let mut buffer = Vec::new();
    file.take(max_bytes as u64)
        .read_to_end(&mut buffer)
        .await
        .map_err(|e| format!("Could not read {path}: {e}"))?;

    // The cut can land inside a multi-byte character; drop the partial one
    // rather than showing a replacement glyph in the preview.
    let text = match std::str::from_utf8(&buffer) {
        Ok(text) => text.to_string(),
        Err(e) => String::from_utf8_lossy(&buffer[..e.valid_up_to()]).into_owned(),
    };

    Ok(FileHead {
        truncated: total_bytes > buffer.len() as u64,
        total_bytes,
        text,
    })
}

/// The defaults the restore dialog starts from.
#[tauri::command]
#[specta::specta]
pub async fn default_restore_options() -> Result<RestoreOptions, String> {
    Ok(RestoreOptions::default())
}

/// Ask a running backup or restore to stop.
///
/// Returns whether there was one to stop — a Cancel arriving just as the dump
/// finishes is not an error, and reporting one would put a failure in front of
/// the user for a backup that succeeded.
#[tauri::command]
#[tracing::instrument]
#[specta::specta]
pub async fn cancel_backup(backup_id: String) -> Result<bool, String> {
    let map = running()
        .lock()
        .map_err(|_| "The backup registry is poisoned".to_string())?;
    match map.get(&backup_id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// What the dialog starts from, so the defaults live in one place.
#[tauri::command]
#[specta::specta]
pub async fn default_backup_options() -> Result<BackupOptions, String> {
    Ok(BackupOptions::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelling_a_backup_that_is_not_running_is_not_an_error() {
        // The Cancel button can always be pressed, including in the moment
        // between the last row and the return.
        assert!(!cancel_backup("no-such-backup".to_string()).await.unwrap());
    }

    #[tokio::test]
    async fn cancelling_sets_the_flag_the_dump_watches() {
        let flag = Arc::new(AtomicBool::new(false));
        running()
            .lock()
            .unwrap()
            .insert("b1".to_string(), flag.clone());

        assert!(cancel_backup("b1".to_string()).await.unwrap());
        assert!(flag.load(Ordering::Relaxed));

        running().lock().unwrap().remove("b1");
    }

    #[test]
    fn the_registration_guard_removes_the_flag() {
        {
            let _registration = Registration("b2".to_string());
            running()
                .lock()
                .unwrap()
                .insert("b2".to_string(), Arc::new(AtomicBool::new(false)));
        }
        assert!(!running().lock().unwrap().contains_key("b2"));
    }
}
