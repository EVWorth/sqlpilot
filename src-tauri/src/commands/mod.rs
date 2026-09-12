#[cfg(feature = "beta-ai")]
pub mod ai;
pub mod backup;
pub mod sqlite;

use mas_admin::AdminService;
use mas_core::connection::manager::PoolStats;
use mas_core::connection::{ConnectionHealth, ConnectionManager, ConnectionStore};
use mas_core::history::{
    render_export, HistoryEntry, HistoryExportFormat, HistoryFacets, HistoryQuery, HistoryStore,
};
use mas_core::models::{
    ConnectionInfo, ConnectionProfile, ConnectionProfileSummary, QueryResult, TestConnectionResult,
};
use mas_core::query::{ExplainFormat, ExplainResponse, QueryExecutor};
use mas_core::schema::inspector::{
    ColumnInfo, DatabaseInfo, EventInfo, ForeignKeyInfo, IndexInfo, PartitionInfo, RoutineInfo,
    TableInfo, TriggerInfo, ViewInfo,
};
use mas_core::schema::SchemaInspector;
use mas_core::QueryError;
use mas_sqlite::connection::SqliteConnectionManager;
use mas_sqlite::query::SqliteQueryExecutor;
use mas_sqlite::schema::SqliteSchemaInspector;
use serde::{Deserialize, Serialize};
// Unconditional now: the platform probe reads paths on every target, where
// the previous rpm-ostree check was Linux-only.
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

pub struct AppState {
    pub connection_manager: Arc<ConnectionManager>,
    pub connection_store: ConnectionStore,
    pub query_executor: QueryExecutor,
    pub schema_inspector: SchemaInspector,
    pub history_store: HistoryStore,
    pub admin_service: AdminService,
    #[cfg(feature = "beta-ai")]
    pub ai_service: Option<mas_ai::AiService>,
    pub sqlite_manager: Arc<SqliteConnectionManager>,
    pub sqlite_executor: Arc<SqliteQueryExecutor>,
    pub sqlite_inspector: Arc<SqliteSchemaInspector>,
}

// Connection commands
#[tauri::command]
#[tracing::instrument(skip(state, profile), fields(profile_name = %profile.name))]
#[specta::specta]
pub async fn save_connection_profile(
    state: State<'_, AppState>,
    mut profile: ConnectionProfile,
) -> Result<String, String> {
    // The frontend never receives credentials — they are
    // #[serde(skip_serializing)] — so on edit it sends them back absent. Absent
    // therefore means "keep what is stored", not "clear it". An explicitly
    // empty SSH credential does mean clear, which is how one gets removed.
    let needs_stored = profile.password.is_empty()
        || profile
            .ssh_config
            .as_ref()
            .is_some_and(|c| c.password.is_none() || c.passphrase.is_none());
    if needs_stored {
        // `if let Ok(..)` here was the bug: it treated a locked or unavailable
        // keyring exactly like "this profile has no stored password", left the
        // field empty, and let the save below delete the credential — while
        // reporting success (#274). A missing profile is fine; anything else
        // means refusing to save rather than destroying what is stored.
        let stored = state
            .connection_store
            .get_existing(&profile.id)
            .map_err(|e| {
                tracing::error!(error = %e, profile_id = %profile.id, "Refusing to save: stored credentials unreadable");
                format!(
                    "Could not read the saved credentials for this profile, so nothing was saved \
                     and the stored password is untouched. This usually means the OS keyring is \
                     locked or unavailable. Underlying error: {}",
                    e
                )
            })?;

        if let Some(stored) = stored {
            if profile.password.is_empty() {
                profile.password = stored.password;
            }
            if let (Some(incoming), Some(stored_ssh)) =
                (profile.ssh_config.as_mut(), stored.ssh_config)
            {
                if incoming.password.is_none() {
                    incoming.password = stored_ssh.password;
                }
                if incoming.passphrase.is_none() {
                    incoming.passphrase = stored_ssh.passphrase;
                }
            }
        }
    }
    state.connection_store.save(&profile).map_err(|e| {
        tracing::error!(error = %e, "Failed to save connection profile");
        e.to_string()
    })?;
    tracing::info!(profile_id = %profile.id, "Connection profile saved");
    Ok(profile.id.clone())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn list_connection_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfileSummary>, String> {
    let profiles = state.connection_store.list().map_err(|e| {
        tracing::error!(error = %e, "Failed to list connection profiles");
        e.to_string()
    })?;
    tracing::info!(count = profiles.len(), "Listed connection profiles");
    Ok(profiles)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn delete_connection_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), String> {
    state.connection_store.delete(&profile_id).map_err(|e| {
        tracing::error!(error = %e, profile_id = %profile_id, "Failed to delete connection profile");
        e.to_string()
    })?;
    tracing::info!("Connection profile deleted");
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(state, profile), fields(profile_name = %profile.name, host = %profile.host, port = %profile.port))]
#[specta::specta]
pub async fn test_connection(
    state: State<'_, AppState>,
    mut profile: ConnectionProfile,
) -> Result<TestConnectionResult, String> {
    // If the frontend omitted the password (edit mode), look it up from the
    // store. A keyring failure here is reported rather than swallowed: testing
    // with a silently-empty password produces "Access denied", which sends the
    // user off to debug credentials that are perfectly fine (#274).
    if profile.password.is_empty() {
        let stored = state
            .connection_store
            .get_existing(&profile.id)
            .map_err(|e| {
                tracing::error!(error = %e, "Could not read stored credentials for test");
                format!(
                    "Could not read the saved password for this profile — the OS keyring may be \
                     locked or unavailable. Underlying error: {}",
                    e
                )
            })?;
        if let Some(stored) = stored {
            profile.password = stored.password;
        }
    }
    let result = ConnectionManager::test_connection(&profile)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Test connection failed");
            e.to_string()
        })?;
    tracing::info!(
        success = result.success,
        latency_ms = result.latency_ms,
        "Test connection completed"
    );
    Ok(result)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn connect(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<ConnectionInfo, String> {
    let profile = state.connection_store.get(&profile_id).map_err(|e| {
        tracing::error!(error = %e, "Failed to get profile for connect");
        e.to_string()
    })?;
    let info = state
        .connection_manager
        .connect(&profile)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Connect failed");
            e.to_string()
        })?;
    tracing::info!(connection_id = %info.id, server_version = %info.server_version, "Connected");
    Ok(info)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn disconnect(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    state
        .connection_manager
        .disconnect(&connection_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Disconnect failed");
            e.to_string()
        })?;
    tracing::info!("Disconnected");
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn list_connections(state: State<'_, AppState>) -> Result<Vec<ConnectionInfo>, String> {
    let connections = state.connection_manager.list_connections();
    tracing::info!(count = connections.len(), "Listed connections");
    Ok(connections)
}

// Query commands
#[tauri::command]
#[tracing::instrument(skip(state), fields(connection_id = %connection_id, sql_preview = %sql.chars().take(100).collect::<String>()))]
#[specta::specta]
pub async fn execute_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    database: Option<String>,
    // u32: specta forbids exporting u64, and a LIMIT above 4.29e9 is
    // meaningless. Widened back for the executor below.
    limit: Option<u32>,
    // Rows to skip before the first one kept, so the grid can page through a
    // result the row limit would otherwise cut off at page one (#391).
    offset: Option<u32>,
) -> Result<Vec<QueryResult>, QueryError> {
    // Structured rather than a string: the history panel needs to tell a
    // missing table from a syntax error, and the driver already knows which
    // it was (#324).
    let results = state
        .query_executor
        .execute_owned(
            connection_id,
            sql,
            database,
            limit.map(u64::from),
            offset.map(u64::from),
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Query execution failed");
            QueryError::from_core(&e)
        })?;
    let total_rows: u64 = results.iter().map(|r| r.rows_affected).sum();
    tracing::info!(
        statement_count = results.len(),
        total_rows = total_rows,
        "Query executed"
    );
    Ok(results)
}

/// A connection has gone away, or come back.
///
/// Emitted on every check while a connection is down — so the UI can count
/// the attempts — and on each change while it is up, since a heartbeat every
/// fifteen seconds is not news (#276).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ConnectionHealthEvent(pub ConnectionHealth);

/// Forward health changes from the core to the frontend.
///
/// Spawned once at startup: the manager broadcasts, this turns each message
/// into a Tauri event. Keeping the core free of `AppHandle` is what lets the
/// health checker be tested without a window.
pub fn forward_health_events(manager: std::sync::Arc<ConnectionManager>, app: tauri::AppHandle) {
    use tauri_specta::Event as _;
    let mut events = manager.subscribe_health();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(health) => {
                    if let Err(e) = ConnectionHealthEvent(health).emit(&app) {
                        tracing::warn!(error = %e, "Could not emit a connection health event");
                    }
                }
                // Lagged: the UI missed some heartbeats, which the next one
                // makes good. Closed: the manager is gone, so is the app.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::debug!(missed = n, "Health event subscriber lagged");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });
}

/// What the health checker last saw for a connection.
///
/// The checker reports changes as `connection-health-event`; this is for a
/// caller that wants the state now — on mount, or after the window has been
/// hidden and the events missed.
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn connection_health(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Option<ConnectionHealth>, String> {
    Ok(state.connection_manager.health_of(&connection_id))
}

/// Check a connection now rather than waiting for the next scheduled ping.
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn ping_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<ConnectionHealth, String> {
    let pool = state
        .connection_manager
        .get_pool(&connection_id)
        .map_err(|e| e.to_string())?;
    let result = mas_core::connection::health::ping(&pool).await;
    Ok(ConnectionHealth {
        connection_id,
        healthy: result.is_ok(),
        latency_ms: result.as_ref().ok().copied(),
        error: result.err(),
        consecutive_failures: 0,
    })
}

/// How full each live pool is, for the status bar (FR-1.2.3).
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn pool_stats(state: State<'_, AppState>) -> Result<Vec<PoolStats>, String> {
    Ok(state.connection_manager.pool_stats())
}

/// Plan a single statement.
///
/// Separate from `execute_query` because `EXPLAIN ANALYZE` executes what it
/// measures: the decision to downgrade a write to a plain EXPLAIN has to sit
/// behind the IPC boundary, not in the caller (#412).
#[tauri::command]
#[tracing::instrument(skip(state, sql))]
#[specta::specta]
pub async fn explain_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    database: Option<String>,
    analyze: bool,
    // Absent means the tabular plan, so a caller that does not care about
    // the format keeps working.
    format: Option<ExplainFormat>,
) -> Result<ExplainResponse, String> {
    mas_core::query::explain(
        &state.connection_manager,
        &state.query_executor,
        connection_id,
        sql,
        database,
        analyze,
        format.unwrap_or(ExplainFormat::Classic),
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "EXPLAIN failed");
        e.to_string()
    })
}

/// Stop whatever is running on this connection.
///
/// Issues `KILL QUERY` server-side — dropping the client future alone would
/// leave the statement running to completion (#420).
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn cancel_query(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    state
        .query_executor
        .cancel(&connection_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Cancel failed");
            e.to_string()
        })
}

// Schema commands
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DatabaseInfo>, String> {
    let dbs = state
        .schema_inspector
        .get_databases(&connection_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get databases");
            e.to_string()
        })?;
    tracing::info!(count = dbs.len(), "Listed databases");
    Ok(dbs)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_tables(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<TableInfo>, String> {
    let tables = state
        .schema_inspector
        .get_tables(&connection_id, &database)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get tables");
            e.to_string()
        })?;
    tracing::info!(count = tables.len(), "Listed tables");
    Ok(tables)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_columns(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    let columns = state
        .schema_inspector
        .get_columns(&connection_id, &database, &table)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get columns");
            e.to_string()
        })?;
    tracing::info!(count = columns.len(), "Listed columns");
    Ok(columns)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_events(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<EventInfo>, String> {
    let events = state
        .schema_inspector
        .get_events(&connection_id, &database)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get events");
            e.to_string()
        })?;
    tracing::info!(count = events.len(), "Listed events");
    Ok(events)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_partitions(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<PartitionInfo>, String> {
    let partitions = state
        .schema_inspector
        .get_partitions(&connection_id, &database, &table)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get partitions");
            e.to_string()
        })?;
    tracing::info!(count = partitions.len(), "Listed partitions");
    Ok(partitions)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_foreign_keys(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let keys = state
        .schema_inspector
        .get_foreign_keys(&connection_id, &database, &table)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get foreign keys");
            e.to_string()
        })?;
    tracing::info!(count = keys.len(), "Listed foreign keys");
    Ok(keys)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<IndexInfo>, String> {
    let indexes = state
        .schema_inspector
        .get_indexes(&connection_id, &database, &table)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get indexes");
            e.to_string()
        })?;
    tracing::info!(count = indexes.len(), "Listed indexes");
    Ok(indexes)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_table_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<String, String> {
    let ddl = state
        .schema_inspector
        .get_table_ddl(&connection_id, &database, &table)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get table DDL");
            e.to_string()
        })?;
    tracing::info!(ddl_length = ddl.len(), "Retrieved table DDL");
    Ok(ddl)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_views(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<ViewInfo>, String> {
    let views = state
        .schema_inspector
        .get_views(&connection_id, &database)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get views");
            e.to_string()
        })?;
    tracing::info!(count = views.len(), "Listed views");
    Ok(views)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_routines(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<RoutineInfo>, String> {
    let routines = state
        .schema_inspector
        .get_routines(&connection_id, &database)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get routines");
            e.to_string()
        })?;
    tracing::info!(count = routines.len(), "Listed routines");
    Ok(routines)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_triggers(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<TriggerInfo>, String> {
    let triggers = state
        .schema_inspector
        .get_triggers(&connection_id, &database)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get triggers");
            e.to_string()
        })?;
    tracing::info!(count = triggers.len(), "Listed triggers");
    Ok(triggers)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_view_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    view_name: String,
) -> Result<String, String> {
    let ddl = state
        .schema_inspector
        .get_view_ddl(&connection_id, &database, &view_name)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get view DDL");
            e.to_string()
        })?;
    tracing::info!(ddl_length = ddl.len(), "Retrieved view DDL");
    Ok(ddl)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_routine_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    routine_name: String,
    routine_type: String,
) -> Result<String, String> {
    let ddl = state
        .schema_inspector
        .get_routine_ddl(&connection_id, &database, &routine_name, &routine_type)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get routine DDL");
            e.to_string()
        })?;
    tracing::info!(ddl_length = ddl.len(), "Retrieved routine DDL");
    Ok(ddl)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_trigger_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    trigger_name: String,
) -> Result<String, String> {
    let ddl = state
        .schema_inspector
        .get_trigger_ddl(&connection_id, &database, &trigger_name)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get trigger DDL");
            e.to_string()
        })?;
    tracing::info!(ddl_length = ddl.len(), "Retrieved trigger DDL");
    Ok(ddl)
}

// Export commands
#[tauri::command]
#[tracing::instrument(skip(result), fields(format = %format, rows = result.rows.len(), cols = result.columns.len()))]
#[specta::specta]
pub async fn export_results(
    result: QueryResult,
    format: String,
    table_name: Option<String>,
) -> Result<String, String> {
    let output = match format.as_str() {
        "csv" => Ok(mas_export::export_csv(&result)),
        "json" => Ok(mas_export::export_json(&result)),
        "sql" => Ok(mas_export::export_sql_insert(
            &result,
            &table_name.unwrap_or("table".to_string()),
        )),
        "markdown" => Ok(mas_export::export_markdown(&result)),
        _ => {
            tracing::error!(format = %format, "Unknown export format");
            Err(format!("Unknown format: {}", format))
        }
    }?;
    tracing::info!(output_bytes = output.len(), "Export completed");
    Ok(output)
}

// Admin commands
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_process_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<mas_admin::ProcessInfo>, String> {
    let processes = state
        .admin_service
        .get_process_list(&connection_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get process list");
            e.to_string()
        })?;
    tracing::info!(count = processes.len(), "Listed processes");
    Ok(processes)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_server_variables(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<mas_admin::ServerVariable>, String> {
    let vars = state
        .admin_service
        .get_server_variables(&connection_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get server variables");
            e.to_string()
        })?;
    tracing::info!(count = vars.len(), "Listed server variables");
    Ok(vars)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn kill_process(
    state: State<'_, AppState>,
    connection_id: String,
    process_id: mas_admin::ProcessId,
) -> Result<(), String> {
    state
        .admin_service
        .kill_process(&connection_id, process_id.0)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to kill process");
            e.to_string()
        })?;
    tracing::info!("Process killed");
    Ok(())
}

/// Abort the statement a session is running, without dropping the session.
///
/// The proportionate response to a long-running query: `kill_process` drops
/// the whole connection and its transaction with it (#430).
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn kill_query(
    state: State<'_, AppState>,
    connection_id: String,
    process_id: mas_admin::ProcessId,
) -> Result<(), String> {
    state
        .admin_service
        .kill_query(&connection_id, process_id.0)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to kill query");
            e.to_string()
        })?;
    tracing::info!("Query killed");
    Ok(())
}

/// Server thread ids belonging to SQLPilot's own pool for this connection.
///
/// The process list shows every session on the server, including the ones the
/// app is using to read that very list. The UI needs to tell them apart so it
/// can present its own as un-killable rather than letting the user disconnect
/// the app from the server it is managing (#433).
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn get_own_thread_ids(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<mas_admin::ProcessId>, String> {
    Ok(state
        .connection_manager
        .own_thread_ids(&connection_id)
        .into_iter()
        .map(|id| mas_admin::ProcessId(id as i64))
        .collect())
}

/// Whether the OS credential store was available at startup.
///
/// Read by the frontend so it can say plainly that passwords will not be
/// remembered, rather than the user discovering it when one fails to save
/// (#278).
static KEYRING_AVAILABLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_keyring_available(available: bool) {
    KEYRING_AVAILABLE.store(available, std::sync::atomic::Ordering::Relaxed);
}

/// Whether connection passwords can be stored between sessions.
#[tauri::command]
#[specta::specta]
pub fn keyring_available() -> bool {
    KEYRING_AVAILABLE.load(std::sync::atomic::Ordering::Relaxed)
}

// Platform detection
//
// `tauri-plugin-updater` shells out to `rpm -U` on Linux, which is a no-op
// (or worse, writes into a shadowed /var/lib/rpm) on atomic distros that use
// `rpm-ostree` (Bazzite, Fedora Silverblue, Bluefin, Aurora, Universal Blue,
// Fedora Atomic). The frontend uses this signal to suppress the auto-update
// chip and surface a copyable `rpm-ostree install <url>` command instead.
// On non-Linux targets, the answer is always false so the frontend short-
// circuits without a runtime branch.
#[tauri::command]
#[tracing::instrument]
#[specta::specta]
pub async fn get_platform_info() -> Result<PlatformInfo, String> {
    Ok(PlatformInfo {
        package_format: detect_package_format(&RealProbe),
        arch: std::env::consts::ARCH.to_string(),
    })
}

/// How this copy of SQLPilot was installed, which decides whether it may
/// update itself.
///
/// The previous check was `Path::new("/usr/bin/rpm-ostree").exists()`, which
/// answers a narrower question than the one being asked and gets the
/// important case backwards. Inside a Flatpak sandbox the host's `/usr` is
/// not visible, so a Flatpak on Silverblue sees no rpm-ostree binary, reports
/// itself as an ordinary install, and is offered an auto-update its runtime
/// cannot apply (#354).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PackageFormat {
    /// A plain install that owns its own files, and can replace them.
    Standard,
    /// Tauri's updater handles this format directly.
    AppImage,
    /// The runtime owns updates; the app must not replace its own files.
    Flatpak,
    /// As Flatpak — snapd manages the revision.
    Snap,
    /// An OSTree-booted system: /usr is immutable and layered packages are
    /// applied by rpm-ostree, taking effect on the next boot.
    RpmOstree,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PlatformInfo {
    pub package_format: PackageFormat,
    /// `x86_64`, `aarch64`. Needed to name the right download in a manual
    /// update command (#571).
    pub arch: String,
}

/// The filesystem and environment questions the detection asks, so the
/// decision can be tested without arranging a Flatpak sandbox.
pub trait PlatformProbe {
    fn path_exists(&self, path: &str) -> bool;
    fn env(&self, key: &str) -> Option<String>;
}

struct RealProbe;

impl PlatformProbe for RealProbe {
    fn path_exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }
    fn env(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// Sandboxes are checked first, and deliberately.
///
/// Inside a Flatpak or a Snap the host's markers are either invisible or not
/// ours to act on, so what matters is the sandbox itself. `/.flatpak-info`
/// exists in every Flatpak sandbox; `SNAP` is set for every snap; `APPIMAGE`
/// is set by the AppImage runtime. `/run/ostree-booted` is the marker for an
/// OSTree-booted host, and is a better question than whether an rpm-ostree
/// binary happens to be installed.
pub fn detect_package_format(probe: &impl PlatformProbe) -> PackageFormat {
    if !cfg!(target_os = "linux") {
        return PackageFormat::Standard;
    }
    if probe.path_exists("/.flatpak-info") || probe.env("FLATPAK_ID").is_some() {
        return PackageFormat::Flatpak;
    }
    if probe.env("SNAP").is_some() {
        return PackageFormat::Snap;
    }
    if probe.env("APPIMAGE").is_some() {
        return PackageFormat::AppImage;
    }
    if probe.path_exists("/run/ostree-booted") {
        return PackageFormat::RpmOstree;
    }
    PackageFormat::Standard
}

// File import commands
/// The largest file the import and restore dialogs will open.
///
/// Chosen from what the pipeline can actually survive rather than from disk:
/// the bytes become a Rust String, then a JavaScript string, then parsed rows,
/// all live at the same time. 256 MB of CSV is already several times that in
/// the renderer.
const MAX_READ_BYTES: u64 = 256 * 1024 * 1024;

fn human_bytes(bytes: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else {
        format!("{} bytes", bytes)
    }
}

#[tauri::command]
#[tracing::instrument]
#[specta::specta]
pub async fn read_file_contents(path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;
    if !path_buf.is_file() {
        return Err(format!("Not a regular file: {}", path));
    }

    // Refuse before reading rather than after. Everything downstream — this
    // string, the JavaScript copy of it, the parsed rows — is held in memory
    // at once, so a multi-gigabyte file takes the renderer down before the
    // user sees anything at all. A refusal naming the size is an answer; a
    // frozen window is not (#366).
    let size = tokio::fs::metadata(&path_buf)
        .await
        .map_err(|e| format!("Cannot read {}: {}", path, e))?
        .len();
    if size > MAX_READ_BYTES {
        return Err(format!(
            "{} is {} and the limit is {}. Files this large have to be loaded in \
             their entirety to be shown, which the app cannot do. Split it, or run \
             it with the mysql client.",
            path,
            human_bytes(size),
            human_bytes(MAX_READ_BYTES)
        ));
    }

    let contents = tokio::fs::read_to_string(&path_buf).await.map_err(|e| {
        tracing::error!(error = %e, path = %path, "Failed to read file");
        format!("Failed to read file: {}", e)
    })?;
    tracing::info!(path = %path, bytes = contents.len(), "File read successfully");
    Ok(contents)
}

#[tauri::command]
#[tracing::instrument]
#[specta::specta]
pub async fn pick_file(
    title: String,
    filters: Vec<(String, Vec<String>)>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title(&title);
    for (name, extensions) in &filters {
        let ext_refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(name, &ext_refs);
    }
    let result = dialog.pick_file().await;
    match result {
        Some(handle) => {
            let path = handle.path().to_string_lossy().to_string();
            tracing::info!(path = %path, "File picked");
            Ok(Some(path))
        }
        None => {
            tracing::info!("File pick cancelled");
            Ok(None)
        }
    }
}

#[tauri::command]
#[tracing::instrument(skip(contents), fields(path = %path, content_len = contents.len()))]
#[specta::specta]
pub async fn write_file_contents(path: String, contents: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    // Canonicalize the parent directory so relative paths resolve, but
    // preserve the filename for new files (save-as) that don't exist yet.
    let resolved = if let Some(parent) = path_buf.parent() {
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("Invalid path: {e}"))?;
        canonical_parent.join(
            path_buf
                .file_name()
                .ok_or_else(|| "Invalid path: missing file name".to_string())?,
        )
    } else {
        path_buf
            .canonicalize()
            .map_err(|e| format!("Invalid path: {e}"))?
    };
    tokio::fs::write(&resolved, &contents).await.map_err(|e| {
        tracing::error!(error = %e, path = %path, "Failed to write file");
        format!("Failed to write file: {}", e)
    })?;
    tracing::info!(path = %path, bytes = contents.len(), "File written successfully");
    Ok(())
}

#[tauri::command]
#[tracing::instrument]
#[specta::specta]
pub async fn pick_save_file(
    title: String,
    default_name: String,
    filters: Vec<(String, Vec<String>)>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title(&title)
        .set_file_name(&default_name);
    for (name, extensions) in &filters {
        let ext_refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(name, &ext_refs);
    }
    let result = dialog.save_file().await;
    match result {
        Some(handle) => {
            let path = handle.path().to_string_lossy().to_string();
            tracing::info!(path = %path, "Save file path picked");
            Ok(Some(path))
        }
        None => {
            tracing::info!("Save file pick cancelled");
            Ok(None)
        }
    }
}

#[cfg(test)]
mod platform_tests {
    use super::{detect_package_format, get_platform_info, PackageFormat, PlatformProbe};

    /// A probe answering from a fixed set of facts, so each packaging can be
    /// described without arranging the real thing.
    struct FakeProbe {
        paths: Vec<&'static str>,
        vars: Vec<(&'static str, &'static str)>,
    }

    impl FakeProbe {
        fn nothing() -> Self {
            Self {
                paths: vec![],
                vars: vec![],
            }
        }
        fn with_path(mut self, p: &'static str) -> Self {
            self.paths.push(p);
            self
        }
        fn with_env(mut self, k: &'static str, v: &'static str) -> Self {
            self.vars.push((k, v));
            self
        }
    }

    impl PlatformProbe for FakeProbe {
        fn path_exists(&self, path: &str) -> bool {
            self.paths.contains(&path)
        }
        fn env(&self, key: &str) -> Option<String> {
            self.vars
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_plain_install_is_standard() {
        assert_eq!(
            detect_package_format(&FakeProbe::nothing()),
            PackageFormat::Standard
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_flatpak_is_recognised_by_its_sandbox() {
        assert_eq!(
            detect_package_format(&FakeProbe::nothing().with_path("/.flatpak-info")),
            PackageFormat::Flatpak
        );
        assert_eq!(
            detect_package_format(&FakeProbe::nothing().with_env("FLATPAK_ID", "dev.sqlpilot")),
            PackageFormat::Flatpak
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_flatpak_on_an_ostree_host_is_still_a_flatpak() {
        // The case the old check got backwards. Inside the sandbox the host's
        // /usr is not visible, so a Flatpak on Silverblue saw no rpm-ostree
        // binary, called itself an ordinary install, and was offered an
        // auto-update its runtime cannot apply (#354).
        let probe = FakeProbe::nothing()
            .with_path("/.flatpak-info")
            .with_path("/run/ostree-booted");
        assert_eq!(detect_package_format(&probe), PackageFormat::Flatpak);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_snap_is_recognised() {
        assert_eq!(
            detect_package_format(&FakeProbe::nothing().with_env("SNAP", "/snap/sqlpilot/12")),
            PackageFormat::Snap
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_appimage_is_recognised() {
        assert_eq!(
            detect_package_format(
                &FakeProbe::nothing().with_env("APPIMAGE", "/home/a/SQLPilot.AppImage")
            ),
            PackageFormat::AppImage
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_ostree_host_is_recognised_by_the_boot_marker() {
        // Not by whether an rpm-ostree binary happens to be installed, which
        // is true on plenty of ordinary Fedora systems.
        assert_eq!(
            detect_package_format(&FakeProbe::nothing().with_path("/run/ostree-booted")),
            PackageFormat::RpmOstree
        );
        assert_eq!(
            detect_package_format(&FakeProbe::nothing().with_path("/usr/bin/rpm-ostree")),
            PackageFormat::Standard
        );
    }

    #[tokio::test]
    async fn platform_info_reports_this_machine() {
        let info = get_platform_info().await.unwrap();
        assert!(!info.arch.is_empty());
    }

    #[tokio::test]
    async fn platform_info_agrees_with_this_machine() {
        // No fixed expectation — the runner may be anything. What must hold
        // is that the command answers, and answers the same as the detection
        // it delegates to.
        let info = get_platform_info().await.unwrap();
        assert_eq!(info.arch, std::env::consts::ARCH);
        #[cfg(not(target_os = "linux"))]
        assert_eq!(info.package_format, PackageFormat::Standard);
    }
}

#[cfg(test)]
mod file_command_tests {
    //! Tests for the file-IO Tauri commands (`read_file_contents`,
    //! `write_file_contents`). These don't require a MySQL container so
    //! they run as plain unit tests alongside the rest of the module.
    use super::{read_file_contents, write_file_contents};
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn read_file_contents_returns_file_body() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("hello.sql");
        fs::write(&path, "SELECT 1;\nSELECT 2;\n").expect("write");

        let contents = read_file_contents(path.to_string_lossy().to_string())
            .await
            .expect("read ok");
        assert_eq!(contents, "SELECT 1;\nSELECT 2;\n");
    }

    #[tokio::test]
    async fn read_file_contents_rejects_missing_path() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("does-not-exist.sql");

        let err = read_file_contents(path.to_string_lossy().to_string())
            .await
            .unwrap_err();
        // Either "Invalid path" (canonicalize fails) or "Failed to read file"
        // (canonicalize succeeds because parent exists, then read fails).
        assert!(
            err.contains("Invalid path") || err.contains("Failed to read file"),
            "unexpected error: {err}",
        );
    }

    #[tokio::test]
    async fn read_file_contents_rejects_directory_path() {
        let dir = TempDir::new().expect("tempdir");
        let err = read_file_contents(dir.path().to_string_lossy().to_string())
            .await
            .unwrap_err();
        assert!(
            err.contains("Not a regular file"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn write_file_contents_creates_file_with_body() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("out.sql");

        write_file_contents(
            path.to_string_lossy().to_string(),
            "CREATE TABLE x (id INT)".to_string(),
        )
        .await
        .expect("write ok");

        let written = fs::read_to_string(&path).expect("read back");
        assert_eq!(written, "CREATE TABLE x (id INT)");
    }

    #[tokio::test]
    async fn write_file_contents_overwrites_existing_file() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("out.sql");
        fs::write(&path, "OLD CONTENT").expect("write seed");

        write_file_contents(
            path.to_string_lossy().to_string(),
            "NEW CONTENT".to_string(),
        )
        .await
        .expect("write ok");

        let written = fs::read_to_string(&path).expect("read back");
        assert_eq!(written, "NEW CONTENT");
    }

    #[tokio::test]
    async fn write_file_contents_rejects_missing_parent_dir() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("nope").join("nope").join("out.sql");

        let err = write_file_contents(path.to_string_lossy().to_string(), "x".to_string())
            .await
            .unwrap_err();
        assert!(err.contains("Invalid path"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn read_write_roundtrip_preserves_unicode_content() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("rt.sql");

        let payload = "SELECT 'unicode: ümläut 🚀';\n-- comment\nSELECT 2;";
        write_file_contents(path.to_string_lossy().to_string(), payload.to_string())
            .await
            .expect("write");
        let round_tripped = read_file_contents(path.to_string_lossy().to_string())
            .await
            .expect("read");
        assert_eq!(round_tripped, payload);
    }

    #[tokio::test]
    async fn read_file_contents_refuses_a_file_too_large_to_show() {
        // Refused from its metadata, before any of it is read: the point is
        // to answer instead of taking the renderer down with it (#366).
        let dir = std::env::temp_dir().join("mas_read_limit");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("huge.csv");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(super::MAX_READ_BYTES + 1).unwrap();
        drop(file);

        let err = read_file_contents(path.to_string_lossy().to_string())
            .await
            .expect_err("should refuse a file over the limit");
        assert!(err.contains("limit is"), "{err}");
        assert!(err.contains("MB"), "{err}");

        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn read_file_contents_allows_a_file_at_the_limit() {
        // The boundary itself is allowed, so the message never contradicts
        // the behaviour.
        let dir = std::env::temp_dir().join("mas_read_limit");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("exact.txt");
        std::fs::write(&path, "small").unwrap();

        assert!(read_file_contents(path.to_string_lossy().to_string())
            .await
            .is_ok());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn human_bytes_reads_as_a_person_would_say_it() {
        assert_eq!(super::human_bytes(512), "512 bytes");
        assert_eq!(super::human_bytes(256 * 1024 * 1024), "256.0 MB");
    }
}

// History commands
//
// History moved out of the renderer's localStorage (#585): that medium shares
// a small origin quota with settings and favorites, drops writes silently when
// it fills, and is wiped when the user clears site data.

/// Record one executed statement, then trim to `limit`.
#[tauri::command]
#[tracing::instrument(skip(state, entry))]
#[specta::specta]
pub async fn history_add(
    state: State<'_, AppState>,
    entry: HistoryEntry,
    limit: u32,
) -> Result<HistoryEntry, String> {
    state.history_store.add(&entry, limit).map_err(|e| {
        tracing::error!(error = %e, "Recording history failed");
        e.to_string()
    })
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn history_list(
    state: State<'_, AppState>,
    query: HistoryQuery,
) -> Result<Vec<HistoryEntry>, String> {
    state.history_store.list(&query).map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn history_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.history_store.remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn history_clear(state: State<'_, AppState>) -> Result<(), String> {
    state.history_store.clear().map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn history_count(state: State<'_, AppState>) -> Result<u32, String> {
    state
        .history_store
        .count()
        .map(|n| n.clamp(0, i64::from(u32::MAX)) as u32)
        .map_err(|e| e.to_string())
}

/// Apply a lowered retention limit straight away.
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn history_prune(state: State<'_, AppState>, limit: u32) -> Result<u32, String> {
    state
        .history_store
        .prune(limit)
        .map(|n| n as u32)
        .map_err(|e| e.to_string())
}

/// Drop history older than `cutoff` (ISO 8601). The age half of FR-9.1.3.
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn history_prune_older_than(
    state: State<'_, AppState>,
    cutoff: String,
) -> Result<u32, String> {
    state
        .history_store
        .prune_older_than(&cutoff)
        .map(|n| n as u32)
        .map_err(|e| e.to_string())
}

/// Take over a history that was still in localStorage. Ids carry across, so
/// running this twice imports nothing the second time.
#[tauri::command]
#[tracing::instrument(skip(state, entries), fields(count = entries.len()))]
#[specta::specta]
pub async fn history_import(
    state: State<'_, AppState>,
    entries: Vec<HistoryEntry>,
    limit: u32,
) -> Result<u32, String> {
    state
        .history_store
        .import(&entries, limit)
        .map(|n| n as u32)
        .map_err(|e| e.to_string())
}

/// How many entries the same filter matches, ignoring its page size.
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn history_count_matching(
    state: State<'_, AppState>,
    query: HistoryQuery,
) -> Result<u32, String> {
    state
        .history_store
        .count_matching(&query)
        .map(|n| n.clamp(0, i64::from(u32::MAX)) as u32)
        .map_err(|e| e.to_string())
}

/// The connections and databases that appear in the history, for the filters.
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn history_facets(state: State<'_, AppState>) -> Result<HistoryFacets, String> {
    state.history_store.facets().map_err(|e| e.to_string())
}

/// Render everything the filter matches, not only the page on screen.
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn history_export(
    state: State<'_, AppState>,
    query: HistoryQuery,
    format: HistoryExportFormat,
) -> Result<String, String> {
    // The caller's page size describes the panel, not the export: someone
    // exporting a filtered view means all of it.
    let full = HistoryQuery {
        limit: None,
        offset: None,
        ..query
    };
    let entries = state.history_store.list(&full).map_err(|e| e.to_string())?;
    Ok(render_export(&entries, format))
}
