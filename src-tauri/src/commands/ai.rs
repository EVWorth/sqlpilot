use mas_ai::{AiMode, AiStatus, AiStreamEvent, AiConfig};
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
    mode: AiMode,
    connection_id: Option<String>,
    database: Option<String>,
) -> Result<String, String> {
    let (tx, mut rx) = mpsc::channel::<AiStreamEvent>(256);

    let emit_handle = app.clone();

    // Spawn a task to forward structured events as Tauri events
    let emitter = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let Err(e) = emit_handle.emit("ai:event", &event) {
                tracing::error!(error = %e, "Failed to emit ai:event");
            }
        }
    });

    let result = state
        .ai_service
        .chat(
            &message,
            &conversation_id,
            &mode,
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

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn ai_cancel(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    state
        .ai_service
        .cancel(&conversation_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "AI cancel failed");
            e.to_string()
        })?;
    tracing::info!(conversation_id = %conversation_id, "AI chat cancelled");
    Ok(())
}
