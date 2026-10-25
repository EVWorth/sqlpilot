//! The native menu bar, which only macOS shows.
//!
//! The menu used to be a hand-written copy of the in-app menu bar
//! (`src/lib/actions.ts`), and it drifted: items went missing, one pointed at
//! an action nothing handled, and nothing could be greyed out (#892). Saved
//! profiles could not be listed at all, because they are data (#863).
//!
//! So the frontend now describes the menu — the same list the in-app menu bar
//! renders, plus the saved profiles and whether each action can run — and
//! `set_native_menu` rebuilds it from that. [`default_menus`] is the menu the
//! app starts with, before the window has loaded and sent its own.
//!
//! Turning a description into a menu happens in two steps. [`plan`] is plain
//! data in, plain data out: it validates the description and arranges it the
//! way macOS expects (an application menu first, the clipboard items as the
//! system's own so text fields keep working). [`realize`] turns the plan into
//! Tauri menu objects and does nothing else, so the part with decisions in it
//! is testable on every platform.

use serde::Deserialize;
use std::collections::HashSet;
use tauri::menu::{
    IsMenuItem, Menu, MenuBuilder, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder,
    HELP_SUBMENU_ID,
};
use tauri::{AppHandle, Runtime};

/// One menu in the menu bar, as the frontend describes it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
pub struct NativeMenu {
    pub label: String,
    pub entries: Vec<NativeMenuEntry>,
}

/// An entry in a menu: an action, a divider, or a nested menu.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeMenuEntry {
    /// Choosing it emits `menu-action` with `id`, as the in-app menu does.
    Item {
        id: String,
        label: String,
        /// Tauri's accelerator syntax, e.g. `CmdOrCtrl+Shift+F`.
        accelerator: Option<String>,
        enabled: bool,
    },
    Separator,
    Submenu {
        label: String,
        enabled: bool,
        entries: Vec<NativeMenuEntry>,
    },
}

/// How deep submenus may nest below a top-level menu.
///
/// The app uses one level ("Connection → Connect to"); the limit is there so a
/// malformed description fails instead of building something nobody can use.
const MAX_SUBMENU_DEPTH: usize = 2;

/// Ids Tauri and muda use for their own items and menus.
const RESERVED_ID_PREFIX: &str = "__tauri";

/// Actions that move to the application menu, where macOS users look for
/// them, in this order.
const APP_MENU_IDS: [&str; 2] = ["about", "check-for-updates"];

/// The application menu ends with the system's Quit, so the frontend's own
/// Quit action is not shown a second time.
const DROPPED_IDS: [&str; 1] = ["quit"];

/// Items that must be the system's own rather than a custom action.
///
/// A custom Copy would emit `menu-action` and run `document.execCommand`,
/// which misses every native text field and the system's responder chain. The
/// system items send the standard selectors, which reach whatever has focus.
fn predefined_for(id: &str) -> Option<Predefined> {
    match id {
        "undo" => Some(Predefined::Undo),
        "redo" => Some(Predefined::Redo),
        "cut" => Some(Predefined::Cut),
        "copy" => Some(Predefined::Copy),
        "paste" => Some(Predefined::Paste),
        "select-all" => Some(Predefined::SelectAll),
        _ => None,
    }
}

/// A system-provided menu item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Predefined {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
}

/// A menu entry after [`plan`]: what [`realize`] builds, one to one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Action {
        id: String,
        label: String,
        accelerator: Option<String>,
        enabled: bool,
    },
    Predefined(Predefined),
    Separator,
    Submenu {
        label: String,
        enabled: bool,
        /// macOS's Help menu, which gets the system's search field.
        help: bool,
        children: Vec<Node>,
    },
}

/// Why a menu description was refused, or the menu could not be built.
#[derive(Debug)]
pub enum MenuError {
    EmptyLabel,
    EmptyId,
    ReservedId(String),
    DuplicateId(String),
    TooDeep(String),
    Tauri(tauri::Error),
}

impl std::fmt::Display for MenuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyLabel => write!(f, "menu entry has an empty label"),
            Self::EmptyId => write!(f, "menu item has an empty id"),
            Self::ReservedId(id) => write!(f, "menu item id {id:?} is reserved"),
            Self::DuplicateId(id) => write!(f, "menu item id {id:?} appears more than once"),
            Self::TooDeep(label) => write!(
                f,
                "submenu {label:?} is nested more than {MAX_SUBMENU_DEPTH} levels deep"
            ),
            Self::Tauri(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for MenuError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Tauri(error) => Some(error),
            _ => None,
        }
    }
}

impl From<tauri::Error> for MenuError {
    fn from(error: tauri::Error) -> Self {
        Self::Tauri(error)
    }
}

/// Validate a description and arrange it into the menu bar macOS expects.
///
/// The first top-level menu is always the application menu (macOS titles it
/// with the app's name whatever it is called), so one is built here, holding
/// About and Check for Updates from the description plus the system's
/// Services, Hide and Quit. Without it, the frontend's File menu would be
/// taken as the application menu and there would be no File menu.
pub fn plan(app_name: &str, menus: &[NativeMenu]) -> Result<Vec<Node>, MenuError> {
    let mut seen = HashSet::new();
    let mut hoisted: Vec<(usize, Node)> = Vec::new();
    let mut planned = Vec::with_capacity(menus.len() + 1);

    for menu in menus {
        if menu.label.trim().is_empty() {
            return Err(MenuError::EmptyLabel);
        }
        let children = plan_entries(&menu.entries, 0, &mut seen, &mut hoisted)?;
        // A menu whose every item moved to the application menu.
        if children.is_empty() {
            continue;
        }
        planned.push(Node::Submenu {
            label: menu.label.clone(),
            enabled: true,
            help: menu.label == "Help",
            children,
        });
    }

    hoisted.sort_by_key(|(order, _)| *order);
    let mut app_menu: Vec<Node> = hoisted.into_iter().map(|(_, node)| node).collect();
    app_menu.extend([
        Node::Separator,
        Node::Predefined(Predefined::Services),
        Node::Separator,
        Node::Predefined(Predefined::Hide),
        Node::Predefined(Predefined::HideOthers),
        Node::Predefined(Predefined::ShowAll),
        Node::Separator,
        Node::Predefined(Predefined::Quit),
    ]);
    planned.insert(
        0,
        Node::Submenu {
            label: app_name.to_string(),
            enabled: true,
            help: false,
            children: tidy_separators(app_menu),
        },
    );
    Ok(planned)
}

fn plan_entries(
    entries: &[NativeMenuEntry],
    depth: usize,
    seen: &mut HashSet<String>,
    hoisted: &mut Vec<(usize, Node)>,
) -> Result<Vec<Node>, MenuError> {
    let mut nodes = Vec::with_capacity(entries.len());
    for entry in entries {
        match entry {
            NativeMenuEntry::Separator => nodes.push(Node::Separator),
            NativeMenuEntry::Item {
                id,
                label,
                accelerator,
                enabled,
            } => {
                if id.is_empty() {
                    return Err(MenuError::EmptyId);
                }
                if id.starts_with(RESERVED_ID_PREFIX) {
                    return Err(MenuError::ReservedId(id.clone()));
                }
                if label.trim().is_empty() {
                    return Err(MenuError::EmptyLabel);
                }
                if !seen.insert(id.clone()) {
                    return Err(MenuError::DuplicateId(id.clone()));
                }
                if DROPPED_IDS.contains(&id.as_str()) {
                    continue;
                }
                if let Some(predefined) = predefined_for(id) {
                    nodes.push(Node::Predefined(predefined));
                    continue;
                }
                let node = Node::Action {
                    id: id.clone(),
                    label: label.clone(),
                    accelerator: accelerator.clone().filter(|a| !a.trim().is_empty()),
                    enabled: *enabled,
                };
                match APP_MENU_IDS.iter().position(|app_id| app_id == id) {
                    Some(order) => hoisted.push((order, node)),
                    None => nodes.push(node),
                }
            }
            NativeMenuEntry::Submenu {
                label,
                enabled,
                entries,
            } => {
                if label.trim().is_empty() {
                    return Err(MenuError::EmptyLabel);
                }
                if depth + 1 > MAX_SUBMENU_DEPTH {
                    return Err(MenuError::TooDeep(label.clone()));
                }
                let children = plan_entries(entries, depth + 1, seen, hoisted)?;
                nodes.push(Node::Submenu {
                    label: label.clone(),
                    enabled: *enabled,
                    help: false,
                    children,
                });
            }
        }
    }
    Ok(tidy_separators(nodes))
}

/// Drop separators at either end and runs of them, which moving and dropping
/// items leaves behind.
fn tidy_separators(nodes: Vec<Node>) -> Vec<Node> {
    let mut tidy: Vec<Node> = Vec::with_capacity(nodes.len());
    for node in nodes {
        let is_separator = node == Node::Separator;
        if is_separator && matches!(tidy.last(), None | Some(Node::Separator)) {
            continue;
        }
        tidy.push(node);
    }
    if tidy.last() == Some(&Node::Separator) {
        tidy.pop();
    }
    tidy
}

/// Build the planned menu bar out of Tauri menu objects.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn realize<R: Runtime>(app: &AppHandle<R>, plan: &[Node]) -> Result<Menu<R>, MenuError> {
    let mut bar = MenuBuilder::new(app);
    for node in plan {
        // macOS accepts only submenus at the top level; plan() makes nothing else.
        if let Some(submenu) = realize_submenu(app, node)? {
            bar = bar.item(&submenu);
        }
    }
    Ok(bar.build()?)
}

fn realize_submenu<R: Runtime>(
    app: &AppHandle<R>,
    node: &Node,
) -> Result<Option<Submenu<R>>, MenuError> {
    let Node::Submenu {
        label,
        enabled,
        help,
        children,
    } = node
    else {
        return Ok(None);
    };
    let mut builder = if *help {
        SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, label)
    } else {
        SubmenuBuilder::new(app, label)
    }
    .enabled(*enabled);

    for child in children {
        builder = match child {
            Node::Separator => builder.separator(),
            Node::Submenu { .. } => match realize_submenu(app, child)? {
                Some(submenu) => builder.item(&submenu),
                None => builder,
            },
            Node::Action {
                id,
                label,
                accelerator,
                enabled,
            } => builder.item(&MenuItem::with_id(
                app,
                id.as_str(),
                label,
                *enabled,
                accelerator.as_deref(),
            )?),
            Node::Predefined(kind) => builder.item(&predefined_item(app, *kind)?),
        };
    }
    Ok(Some(builder.build()?))
}

fn predefined_item<R: Runtime>(
    app: &AppHandle<R>,
    kind: Predefined,
) -> tauri::Result<impl IsMenuItem<R>> {
    match kind {
        Predefined::Undo => PredefinedMenuItem::undo(app, None),
        Predefined::Redo => PredefinedMenuItem::redo(app, None),
        Predefined::Cut => PredefinedMenuItem::cut(app, None),
        Predefined::Copy => PredefinedMenuItem::copy(app, None),
        Predefined::Paste => PredefinedMenuItem::paste(app, None),
        Predefined::SelectAll => PredefinedMenuItem::select_all(app, None),
        Predefined::Services => PredefinedMenuItem::services(app, None),
        Predefined::Hide => PredefinedMenuItem::hide(app, None),
        Predefined::HideOthers => PredefinedMenuItem::hide_others(app, None),
        Predefined::ShowAll => PredefinedMenuItem::show_all(app, None),
        Predefined::Quit => PredefinedMenuItem::quit(app, None),
    }
}

/// The menu the app starts with, before the frontend sends its own.
///
/// It mirrors `MENUS` in `src/lib/actions.ts` with nothing connected, which is
/// how the app starts: actions that need a connection are disabled, and there
/// is no "Connect to" list until the frontend has the profiles. Every id here
/// must have a handler in `AppLayout`; `useNativeMenu.test.ts` reads this
/// file and checks.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn default_menus() -> Vec<NativeMenu> {
    fn item(id: &str, label: &str, accelerator: Option<&str>, enabled: bool) -> NativeMenuEntry {
        NativeMenuEntry::Item {
            id: id.to_string(),
            label: label.to_string(),
            accelerator: accelerator.map(str::to_string),
            enabled,
        }
    }
    fn menu(label: &str, entries: Vec<NativeMenuEntry>) -> NativeMenu {
        NativeMenu {
            label: label.to_string(),
            entries,
        }
    }
    use NativeMenuEntry::Separator;
    const OFFLINE: bool = false;

    vec![
        menu(
            "File",
            vec![
                item("new-query", "New Query Tab", Some("CmdOrCtrl+T"), true),
                Separator,
                item("import", "Import Data…", None, OFFLINE),
                item("backup", "Backup Database…", None, OFFLINE),
                item("restore", "Restore Database…", None, OFFLINE),
                Separator,
                item("quit", "Quit", None, true),
            ],
        ),
        menu(
            "Edit",
            vec![
                item("undo", "Undo", None, true),
                item("redo", "Redo", None, true),
                Separator,
                item("cut", "Cut", None, true),
                item("copy", "Copy", None, true),
                item("paste", "Paste", None, true),
                item("select-all", "Select All", None, true),
                Separator,
                item("find", "Find", Some("CmdOrCtrl+F"), true),
                item("find-replace", "Find & Replace", Some("CmdOrCtrl+H"), true),
            ],
        ),
        menu(
            "Connection",
            vec![
                item("new-connection", "New Connection…", None, true),
                Separator,
                item("disconnect", "Disconnect", None, OFFLINE),
            ],
        ),
        menu(
            "Database",
            vec![
                item("new-table", "New Table…", None, OFFLINE),
                item("refresh-schema", "Refresh Schema Cache", None, OFFLINE),
                item("admin-tools", "Admin Tools", None, OFFLINE),
            ],
        ),
        menu(
            "Tools",
            vec![
                item("format-sql", "Format SQL", Some("CmdOrCtrl+Shift+F"), true),
                Separator,
                item("agents", "Agents…", None, true),
            ],
        ),
        menu(
            "View",
            vec![
                item(
                    "command-palette",
                    "Command Palette",
                    Some("CmdOrCtrl+Shift+P"),
                    true,
                ),
                item("agent-panel", "Agent Panel", None, true),
                Separator,
                item("appearance", "Appearance…", None, true),
                item(
                    "cycle-theme",
                    "Cycle Theme (Dark / Light / System)",
                    None,
                    true,
                ),
                Separator,
                item("zoom-in", "Zoom In", Some("CmdOrCtrl+="), true),
                item("zoom-out", "Zoom Out", Some("CmdOrCtrl+-"), true),
                item("reset-zoom", "Reset Zoom", Some("CmdOrCtrl+0"), true),
            ],
        ),
        menu(
            "Help",
            vec![
                item("check-for-updates", "Check for Updates…", None, true),
                Separator,
                item("keyboard-shortcuts", "Keyboard Shortcuts", Some("F1"), true),
                item("about", "About SQLPilot", None, true),
            ],
        ),
    ]
}

/// The menu the app starts with.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> Result<Menu<R>, MenuError> {
    let plan = plan(&app.package_info().name, &default_menus())?;
    realize(app, &plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, enabled: bool) -> NativeMenuEntry {
        NativeMenuEntry::Item {
            id: id.to_string(),
            label: format!("Label {id}"),
            accelerator: None,
            enabled,
        }
    }

    fn menu(label: &str, entries: Vec<NativeMenuEntry>) -> NativeMenu {
        NativeMenu {
            label: label.to_string(),
            entries,
        }
    }

    fn children(node: &Node) -> &[Node] {
        match node {
            Node::Submenu { children, .. } => children,
            other => panic!("expected a submenu, got {other:?}"),
        }
    }

    fn label(node: &Node) -> &str {
        match node {
            Node::Submenu { label, .. } | Node::Action { label, .. } => label,
            other => panic!("expected a labelled node, got {other:?}"),
        }
    }

    fn action_ids(nodes: &[Node]) -> Vec<&str> {
        nodes
            .iter()
            .filter_map(|node| match node {
                Node::Action { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_default_menu_is_a_valid_plan() {
        let plan = plan("SQLPilot", &default_menus()).expect("default menu plans");
        let labels: Vec<&str> = plan.iter().map(label).collect();
        assert_eq!(
            labels,
            [
                "SQLPilot",
                "File",
                "Edit",
                "Connection",
                "Database",
                "Tools",
                "View",
                "Help"
            ]
        );
    }

    #[test]
    fn the_default_menu_starts_with_connection_actions_disabled() {
        let plan = plan("SQLPilot", &default_menus()).expect("default menu plans");
        let disabled: Vec<&str> = plan
            .iter()
            .flat_map(|menu| children(menu).iter())
            .filter_map(|node| match node {
                Node::Action {
                    id, enabled: false, ..
                } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            disabled,
            [
                "import",
                "backup",
                "restore",
                "disconnect",
                "new-table",
                "refresh-schema",
                "admin-tools"
            ]
        );
    }

    #[test]
    fn puts_an_application_menu_first() {
        // macOS treats the first menu as the application menu whatever it is
        // called, which is how the old menu lost its File menu.
        let plan = plan("SQLPilot", &[menu("File", vec![item("new-query", true)])]).unwrap();
        assert_eq!(label(&plan[0]), "SQLPilot");
        assert_eq!(
            children(&plan[0]).last(),
            Some(&Node::Predefined(Predefined::Quit))
        );
        assert_eq!(label(&plan[1]), "File");
    }

    #[test]
    fn moves_about_and_updates_to_the_application_menu_in_order() {
        let plan = plan(
            "SQLPilot",
            &[menu(
                "Help",
                vec![
                    item("check-for-updates", true),
                    NativeMenuEntry::Separator,
                    item("keyboard-shortcuts", true),
                    item("about", true),
                ],
            )],
        )
        .unwrap();
        assert_eq!(
            action_ids(children(&plan[0])),
            ["about", "check-for-updates"]
        );
        // What is left of Help keeps no stray separator.
        assert_eq!(
            children(&plan[1]),
            [Node::Action {
                id: "keyboard-shortcuts".into(),
                label: "Label keyboard-shortcuts".into(),
                accelerator: None,
                enabled: true,
            }]
        );
    }

    #[test]
    fn marks_help_as_the_help_menu() {
        let plan = plan(
            "SQLPilot",
            &[
                menu("File", vec![item("new-query", true)]),
                menu("Help", vec![item("keyboard-shortcuts", true)]),
            ],
        )
        .unwrap();
        let help: Vec<bool> = plan
            .iter()
            .map(|node| matches!(node, Node::Submenu { help: true, .. }))
            .collect();
        assert_eq!(help, [false, false, true]);
    }

    #[test]
    fn drops_a_menu_that_only_held_moved_items() {
        let plan = plan("SQLPilot", &[menu("Help", vec![item("about", true)])]).unwrap();
        assert_eq!(plan.len(), 1);
    }

    #[test]
    fn uses_the_system_clipboard_items_and_quit() {
        let plan = plan(
            "SQLPilot",
            &[
                menu(
                    "Edit",
                    vec![
                        item("undo", true),
                        item("copy", true),
                        item("select-all", true),
                    ],
                ),
                menu(
                    "File",
                    vec![
                        item("new-query", true),
                        NativeMenuEntry::Separator,
                        item("quit", true),
                    ],
                ),
            ],
        )
        .unwrap();
        assert_eq!(
            children(&plan[1]),
            [
                Node::Predefined(Predefined::Undo),
                Node::Predefined(Predefined::Copy),
                Node::Predefined(Predefined::SelectAll),
            ]
        );
        // Quit lives in the application menu; File does not repeat it, nor
        // keep the separator that stood before it.
        assert_eq!(action_ids(children(&plan[2])), ["new-query"]);
        assert_eq!(children(&plan[2]).len(), 1);
    }

    #[test]
    fn keeps_a_connect_to_submenu_with_its_state() {
        let plan = plan(
            "SQLPilot",
            &[menu(
                "Connection",
                vec![
                    item("new-connection", true),
                    NativeMenuEntry::Submenu {
                        label: "Connect to".into(),
                        enabled: true,
                        entries: vec![item("connect:a", true), item("connect:b", false)],
                    },
                ],
            )],
        )
        .unwrap();
        let connection = children(&plan[1]);
        let Node::Submenu {
            label, children, ..
        } = &connection[1]
        else {
            panic!("expected the Connect to submenu, got {:?}", connection[1]);
        };
        assert_eq!(label, "Connect to");
        let states: Vec<(&str, bool)> = children
            .iter()
            .filter_map(|node| match node {
                Node::Action { id, enabled, .. } => Some((id.as_str(), *enabled)),
                _ => None,
            })
            .collect();
        assert_eq!(states, [("connect:a", true), ("connect:b", false)]);
    }

    #[test]
    fn tidies_separators() {
        let tidy = tidy_separators(vec![
            Node::Separator,
            Node::Predefined(Predefined::Cut),
            Node::Separator,
            Node::Separator,
            Node::Predefined(Predefined::Copy),
            Node::Separator,
        ]);
        assert_eq!(
            tidy,
            [
                Node::Predefined(Predefined::Cut),
                Node::Separator,
                Node::Predefined(Predefined::Copy),
            ]
        );
    }

    #[test]
    fn drops_an_empty_accelerator() {
        let plan = plan(
            "SQLPilot",
            &[menu(
                "File",
                vec![NativeMenuEntry::Item {
                    id: "new-query".into(),
                    label: "New Query Tab".into(),
                    accelerator: Some(" ".into()),
                    enabled: true,
                }],
            )],
        )
        .unwrap();
        assert!(matches!(
            &children(&plan[1])[0],
            Node::Action {
                accelerator: None,
                ..
            }
        ));
    }

    #[test]
    fn refuses_a_duplicate_id() {
        let error = plan(
            "SQLPilot",
            &[
                menu("File", vec![item("new-query", true)]),
                menu("Tools", vec![item("new-query", true)]),
            ],
        )
        .unwrap_err();
        assert!(matches!(error, MenuError::DuplicateId(id) if id == "new-query"));
    }

    #[test]
    fn refuses_empty_and_reserved_ids_and_labels() {
        assert!(matches!(
            plan("SQLPilot", &[menu("File", vec![item("", true)])]),
            Err(MenuError::EmptyId)
        ));
        assert!(matches!(
            plan("SQLPilot", &[menu("File", vec![item("__tauri_x", true)])]),
            Err(MenuError::ReservedId(_))
        ));
        assert!(matches!(
            plan("SQLPilot", &[menu(" ", vec![item("new-query", true)])]),
            Err(MenuError::EmptyLabel)
        ));
    }

    #[test]
    fn refuses_submenus_nested_too_deep() {
        let mut entries = vec![item("leaf", true)];
        for level in 0..=MAX_SUBMENU_DEPTH {
            entries = vec![NativeMenuEntry::Submenu {
                label: format!("Level {level}"),
                enabled: true,
                entries,
            }];
        }
        assert!(matches!(
            plan("SQLPilot", &[menu("File", entries)]),
            Err(MenuError::TooDeep(_))
        ));
    }

    #[test]
    fn reads_the_shape_the_frontend_sends() {
        let json = r#"[{"label":"Connection","entries":[
            {"type":"item","id":"new-connection","label":"New Connection…","accelerator":null,"enabled":true},
            {"type":"submenu","label":"Connect to","enabled":true,"entries":[
                {"type":"item","id":"connect:p1","label":"Local","accelerator":null,"enabled":false}
            ]},
            {"type":"separator"}
        ]}]"#;
        let menus: Vec<NativeMenu> = serde_json::from_str(json).expect("parses");
        assert_eq!(menus[0].entries.len(), 3);
        assert!(matches!(
            &menus[0].entries[1],
            NativeMenuEntry::Submenu { entries, .. } if entries.len() == 1
        ));
    }
}
