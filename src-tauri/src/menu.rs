use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};

pub fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&MenuItem::with_id(
            app,
            "new-query",
            "New Query Tab",
            true,
            Some("CmdOrCtrl+T"),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "import",
            "Import Data…",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "find",
            "Find",
            true,
            Some("CmdOrCtrl+F"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "find-replace",
            "Find & Replace",
            true,
            Some("CmdOrCtrl+H"),
        )?)
        .build()?;

    let connection_menu = SubmenuBuilder::new(app, "Connection")
        .item(&MenuItem::with_id(
            app,
            "new-connection",
            "New Connection…",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "disconnect",
            "Disconnect",
            true,
            None::<&str>,
        )?)
        .build()?;

    let database_menu = SubmenuBuilder::new(app, "Database")
        .item(&MenuItem::with_id(
            app,
            "refresh-schema",
            "Refresh Schema",
            true,
            Some("F5"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "compare-schemas",
            "Compare Schemas",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "admin-tools",
            "Admin Tools",
            true,
            None::<&str>,
        )?)
        .build()?;

    let tools_menu = SubmenuBuilder::new(app, "Tools")
        .item(&MenuItem::with_id(
            app,
            "format-sql",
            "Format SQL",
            true,
            Some("CmdOrCtrl+Shift+F"),
        )?)
        .separator();

    #[cfg(feature = "beta-ai")]
    let tools_menu = tools_menu.item(&MenuItem::with_id(
        app,
        "ai-assistant",
        "AI Assistant",
        true,
        None::<&str>,
    )?);

    let tools_menu = tools_menu.build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItem::with_id(
            app,
            "keyboard-shortcuts",
            "Keyboard Shortcuts",
            true,
            Some("F1"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .build()?;

    MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&connection_menu)
        .item(&database_menu)
        .item(&tools_menu)
        .item(&help_menu)
        .build()
}
