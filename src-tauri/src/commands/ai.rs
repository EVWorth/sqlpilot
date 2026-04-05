use mas_ai::{AiConfig, AiStatus, AiStreamChunk};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use super::AppState;

#[tauri::command]
#[tracing::instrument(skip(state, app, message))]
pub async fn ai_chat(
    state: State<'_, AppState>,
    app: AppHandle,
    message: String,
    conversation_id: String,
    connection_id: Option<String>,
    database: Option<String>,
) -> Result<String, String> {
    let (tx, mut rx) = mpsc::channel::<String>(256);

    let conv_id = conversation_id.clone();
    let emit_handle = app.clone();

    // Spawn a task to forward chunks as Tauri events
    let emitter = tokio::spawn(async move {
        while let Some(delta) = rx.recv().await {
            let chunk = AiStreamChunk {
                conversation_id: conv_id.clone(),
                delta,
                done: false,
            };
            if let Err(e) = emit_handle.emit("ai:chunk", &chunk) {
                tracing::error!(error = %e, "Failed to emit ai:chunk event");
            }
        }
        // Send final done chunk
        let done_chunk = AiStreamChunk {
            conversation_id: conv_id,
            delta: String::new(),
            done: true,
        };
        if let Err(e) = emit_handle.emit("ai:chunk", &done_chunk) {
            tracing::error!(error = %e, "Failed to emit final ai:chunk event");
        }
    });

    let result = state
        .ai_service
        .chat(
            &message,
            &conversation_id,
            connection_id.as_deref(),
            database.as_deref(),
            tx,
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "AI chat failed");
            e.to_string()
        })?;

    // Wait for emitter to finish
    let _ = emitter.await;

    tracing::info!(conversation_id = %conversation_id, "AI chat completed");
    Ok(result)
}

#[tauri::command]
#[tracing::instrument(skip(state, prompt))]
pub async fn ai_generate_sql(
    state: State<'_, AppState>,
    prompt: String,
    connection_id: Option<String>,
    database: Option<String>,
) -> Result<String, String> {
    let result = state
        .ai_service
        .generate_sql(&prompt, connection_id.as_deref(), database.as_deref())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "AI SQL generation failed");
            e.to_string()
        })?;
    tracing::info!("AI SQL generation completed");
    Ok(result)
}

#[tauri::command]
#[tracing::instrument(skip(state, sql))]
pub async fn ai_explain_query(
    state: State<'_, AppState>,
    sql: String,
) -> Result<String, String> {
    let result = state
        .ai_service
        .explain_query(&sql)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "AI query explanation failed");
            e.to_string()
        })?;
    tracing::info!("AI query explanation completed");
    Ok(result)
}

#[tauri::command]
#[tracing::instrument(skip(state, sql))]
pub async fn ai_optimize_query(
    state: State<'_, AppState>,
    sql: String,
    connection_id: Option<String>,
    database: Option<String>,
) -> Result<String, String> {
    let result = state
        .ai_service
        .optimize_query(&sql, connection_id.as_deref(), database.as_deref())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "AI query optimization failed");
            e.to_string()
        })?;
    tracing::info!("AI query optimization completed");
    Ok(result)
}

#[tauri::command]
#[tracing::instrument(skip(state, sql, error_message))]
pub async fn ai_fix_error(
    state: State<'_, AppState>,
    sql: String,
    error_message: String,
) -> Result<String, String> {
    let result = state
        .ai_service
        .fix_error(&sql, &error_message)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "AI error fix failed");
            e.to_string()
        })?;
    tracing::info!("AI error fix completed");
    Ok(result)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn ai_get_status(
    state: State<'_, AppState>,
) -> Result<AiStatus, String> {
    let status = state.ai_service.get_status().await;
    tracing::info!(provider = %status.provider, available = status.available, "AI status retrieved");
    Ok(status)
}

#[tauri::command]
#[tracing::instrument(skip(state, config))]
pub async fn ai_set_config(
    state: State<'_, AppState>,
    config: AiConfig,
) -> Result<(), String> {
    state
        .ai_service
        .set_config(config)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "AI config update failed");
            e.to_string()
        })?;
    tracing::info!("AI configuration updated");
    Ok(())
}
