//! The native menu bar (#863, #892). The decisions live in `crate::menu`;
//! this is the IPC boundary.

use crate::menu::{plan, NativeMenu};

/// Rebuild the native menu bar from the frontend's description of it.
///
/// The frontend calls this whenever what the menu shows changes: the saved
/// profiles, which are connected, whether an action can run. The description
/// is validated on every platform, so a malformed one fails the same way
/// everywhere, but only macOS has a native menu bar to rebuild; elsewhere the
/// in-app menu bar renders the same list and this does nothing more.
///
/// Synchronous on purpose: Tauri runs it on the main thread, where menus are
/// built, so two calls in a row are applied in the order they were sent.
#[tauri::command]
#[tracing::instrument(skip(app, menus), fields(menus = menus.len()))]
#[specta::specta]
pub fn set_native_menu(app: tauri::AppHandle, menus: Vec<NativeMenu>) -> Result<(), String> {
    let plan = plan(&app.package_info().name, &menus).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let menu = crate::menu::realize(&app, &plan).map_err(|e| e.to_string())?;
        app.set_menu(menu).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = plan;

    Ok(())
}
