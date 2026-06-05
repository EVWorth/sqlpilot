use mas_core::connection::ConnectionManager;
use mas_core::error::CoreError;
use serde::Serialize;
use sqlx::Row;
use std::sync::Arc;

pub struct AdminService {
    connection_manager: Arc<ConnectionManager>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessInfo {
    pub id: i64,
    pub user: String,
    pub host: String,
    pub db: Option<String>,
    pub command: String,
    pub time: i64,
    pub state: Option<String>,
    pub info: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerVariable {
    pub name: String,
    pub value: String,
}

impl AdminService {
    pub fn new(connection_manager: Arc<ConnectionManager>) -> Self {
        Self { connection_manager }
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_process_list(
        &self,
        connection_id: &str,
    ) -> Result<Vec<ProcessInfo>, CoreError> {
        tracing::debug!("Fetching process list");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT ID,
                    CAST(USER AS CHAR) AS USER,
                    CAST(HOST AS CHAR) AS HOST,
                    CAST(DB AS CHAR) AS DB,
                    CAST(COMMAND AS CHAR) AS COMMAND,
                    TIME,
                    CAST(STATE AS CHAR) AS STATE,
                    CAST(INFO AS CHAR) AS INFO
             FROM INFORMATION_SCHEMA.PROCESSLIST",
        )
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Query(e.to_string()))?;

        let processes: Vec<ProcessInfo> = rows
            .iter()
            .map(|row| ProcessInfo {
                id: row.try_get::<i64, _>("ID").unwrap_or_default(),
                user: row.try_get("USER").unwrap_or_default(),
                host: row.try_get("HOST").unwrap_or_default(),
                db: row.try_get("DB").ok().flatten(),
                command: row.try_get("COMMAND").unwrap_or_default(),
                time: row.try_get::<i64, _>("TIME").unwrap_or_default(),
                state: row.try_get("STATE").ok().flatten(),
                info: row.try_get("INFO").ok().flatten(),
            })
            .collect();
        tracing::debug!(count = processes.len(), "Retrieved process list");
        Ok(processes)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_server_variables(
        &self,
        connection_id: &str,
    ) -> Result<Vec<ServerVariable>, CoreError> {
        tracing::debug!("Fetching server variables");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query("SHOW GLOBAL VARIABLES")
            .fetch_all(&pool)
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        let variables: Vec<ServerVariable> = rows
            .iter()
            .map(|row| ServerVariable {
                name: row.try_get("Variable_name").unwrap_or_default(),
                value: row.try_get("Value").unwrap_or_default(),
            })
            .collect();
        tracing::debug!(count = variables.len(), "Retrieved server variables");
        Ok(variables)
    }

    #[tracing::instrument(skip(self))]
    pub async fn kill_process(
        &self,
        connection_id: &str,
        process_id: i64,
    ) -> Result<(), CoreError> {
        tracing::info!(process_id = process_id, "Killing MySQL process");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let result = sqlx::query("KILL ?")
            .bind(process_id)
            .execute(&pool)
            .await;
        match result {
            Ok(_) => {
                tracing::info!(process_id = process_id, "Process killed successfully");
                Ok(())
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("Unknown column type") || msg.contains("0xf3") {
                    tracing::warn!(
                        process_id = process_id,
                        "KILL command errored during result parsing (MariaDB compatibility): {}. Process was likely killed.",
                        msg
                    );
                    Ok(())
                } else {
                    tracing::error!(process_id = process_id, error = %msg, "Failed to kill process");
                    Err(CoreError::Query(msg))
                }
            }
        }
    }
}
