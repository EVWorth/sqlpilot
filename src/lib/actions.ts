/**
 * Everything the app can be asked to do, in one list.
 *
 * `DESIGN_REQUIREMENTS.md` §1.3 promises that "every action is accessible via
 * keyboard shortcut" and that "a VS Code-style command palette provides
 * universal access". The palette did not exist, and per-action shortcuts do
 * not scale to an app this size — so for most of these the only route was the
 * menu bar, with a mouse.
 *
 * The palette is the visible half. This list is the half that makes it
 * possible, and it is deliberately the same list the menu bar renders: two
 * copies would drift, which is what #452 and #453 already are. Anything added
 * here appears in both, or the test in `__tests__/actions.test.ts` says why
 * it cannot.
 *
 * Dispatch stays as it was — a `menu-action` event carrying the id. The native
 * macOS menu already emits those, so the palette, the menu bar and the OS menu
 * all arrive at the same handler by the same route.
 */

export interface Action {
  /** Matches a `case` in AppLayout's handler. */
  id: string;
  label: string;
  /** The menu this lives under, and what the palette groups by. */
  category: string;
  /** Shown in both surfaces, so the palette teaches the binding. */
  shortcut?: string;
  /**
   * Keywords that should find this action without appearing in its label.
   *
   * For the cases where someone knows what they want and not what it is
   * called: "theme" should find Appearance, "export" should find Backup.
   */
  keywords?: string[];
}

export type MenuEntry = { type: "item"; id: string } | { type: "separator" };

export interface Menu {
  label: string;
  entries: MenuEntry[];
}

export const ACTIONS: Action[] = [
  { id: "new-query", label: "New Query Tab", category: "File", shortcut: "Ctrl+T" },
  { id: "import", label: "Import Data…", category: "File", keywords: ["csv", "load"] },
  { id: "backup", label: "Backup Database…", category: "File", keywords: ["dump", "export", "sql"] },
  { id: "restore", label: "Restore Database…", category: "File", keywords: ["import", "load", "dump"] },
  { id: "quit", label: "Quit", category: "File", keywords: ["exit", "close"] },

  { id: "undo", label: "Undo", category: "Edit", shortcut: "Ctrl+Z" },
  { id: "redo", label: "Redo", category: "Edit", shortcut: "Ctrl+Y" },
  { id: "cut", label: "Cut", category: "Edit", shortcut: "Ctrl+X" },
  { id: "copy", label: "Copy", category: "Edit", shortcut: "Ctrl+C" },
  { id: "paste", label: "Paste", category: "Edit", shortcut: "Ctrl+V" },
  { id: "select-all", label: "Select All", category: "Edit", shortcut: "Ctrl+A" },
  { id: "find", label: "Find", category: "Edit", shortcut: "Ctrl+F", keywords: ["search"] },
  {
    id: "find-replace",
    label: "Find & Replace",
    category: "Edit",
    shortcut: "Ctrl+H",
    keywords: ["search", "substitute"],
  },

  { id: "new-connection", label: "New Connection…", category: "Connection", keywords: ["server", "database", "add"] },
  { id: "disconnect", label: "Disconnect", category: "Connection" },

  { id: "refresh-schema", label: "Refresh Schema Cache", category: "Database", keywords: ["reload", "tables"] },
  { id: "admin-tools", label: "Admin Tools", category: "Database", keywords: ["users", "privileges", "processes"] },

  {
    id: "format-sql",
    label: "Format SQL",
    category: "Tools",
    shortcut: "Ctrl+Shift+F",
    keywords: ["pretty", "beautify", "indent"],
  },

  { id: "check-for-updates", label: "Check for Updates…", category: "Help", keywords: ["version", "upgrade"] },
  {
    id: "appearance",
    label: "Appearance…",
    category: "View",
    keywords: ["theme", "colours", "colors", "dark", "light"],
  },
  {
    id: "agent-panel",
    label: "Agent Panel",
    category: "View",
    keywords: ["ai", "assistant", "chat", "claude", "copilot"],
  },
  { id: "agents", label: "Agents…", category: "Tools", keywords: ["ai", "mcp", "assistant", "share", "connect"] },
  {
    id: "cycle-theme",
    label: "Cycle Theme (Dark / Light / System)",
    category: "View",
    keywords: ["dark", "light", "appearance"],
  },
  {
    id: "keyboard-shortcuts",
    label: "Keyboard Shortcuts",
    category: "Help",
    shortcut: "F1",
    keywords: ["keys", "bindings", "help"],
  },
  { id: "about", label: "About SQLPilot", category: "Help", keywords: ["version", "licence", "license"] },
];

/** The menu bar's shape: which actions, in what order, with the dividers. */
export const MENUS: Menu[] = [
  {
    label: "File",
    entries: [
      { type: "item", id: "new-query" },
      { type: "separator" },
      { type: "item", id: "import" },
      { type: "item", id: "backup" },
      { type: "item", id: "restore" },
      { type: "separator" },
      { type: "item", id: "quit" },
    ],
  },
  {
    label: "Edit",
    entries: [
      { type: "item", id: "undo" },
      { type: "item", id: "redo" },
      { type: "separator" },
      { type: "item", id: "cut" },
      { type: "item", id: "copy" },
      { type: "item", id: "paste" },
      { type: "item", id: "select-all" },
      { type: "separator" },
      { type: "item", id: "find" },
      { type: "item", id: "find-replace" },
    ],
  },
  {
    label: "Connection",
    entries: [
      { type: "item", id: "new-connection" },
      { type: "separator" },
      { type: "item", id: "disconnect" },
    ],
  },
  {
    label: "Database",
    entries: [
      { type: "item", id: "refresh-schema" },
      { type: "item", id: "admin-tools" },
    ],
  },
  {
    label: "Tools",
    entries: [
      { type: "item", id: "format-sql" },
      { type: "separator" },
      // Configuring what agents may reach is a tool, not a help topic.
      { type: "item", id: "agents" },
    ],
  },
  {
    // Help had become the place things went when no menu obviously owned them:
    // four of its seven entries were not help at all, and the agent chat panel
    // was one of them. What belongs together is what changes the view.
    label: "View",
    entries: [
      { type: "item", id: "agent-panel" },
      { type: "separator" },
      { type: "item", id: "appearance" },
      { type: "item", id: "cycle-theme" },
    ],
  },
  {
    label: "Help",
    entries: [
      { type: "item", id: "check-for-updates" },
      { type: "separator" },
      { type: "item", id: "keyboard-shortcuts" },
      { type: "item", id: "about" },
    ],
  },
];

const byId = new Map(ACTIONS.map((action) => [action.id, action]));

export function actionById(id: string): Action | undefined {
  return byId.get(id);
}

/** Ask the app to do something. */
export function runAction(id: string): void {
  window.dispatchEvent(new CustomEvent("menu-action", { detail: id }));
}

/**
 * Score an action against what someone typed, or null if it does not match.
 *
 * Subsequence matching rather than substring: "fr" should find "Find &
 * Replace", which is the whole reason a palette beats a menu. Lower is better.
 *
 * The scoring is deliberately simple — earlier matches and tighter runs win —
 * because the list is thirty items, not thirty thousand, and a ranking nobody
 * can predict is worse than one that is merely adequate.
 */
export function score(action: Action, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  const label = action.label.toLowerCase();
  const direct = subsequence(label, needle);
  if (direct !== null) return direct;

  // Category next, so "edit" lists the Edit menu's actions.
  const viaCategory = subsequence(action.category.toLowerCase(), needle);
  if (viaCategory !== null) return viaCategory + 1000;

  // Keywords last: they are for finding, not for ranking above a real label.
  for (const keyword of action.keywords ?? []) {
    if (subsequence(keyword.toLowerCase(), needle) !== null) return 2000;
  }
  return null;
}

/** Position-weighted subsequence match, or null if the letters are not in order. */
function subsequence(haystack: string, needle: string): number | null {
  let at = 0;
  let total = 0;
  let previous = -1;
  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found === -1) return null;
    // A letter that continues a run costs nothing; one that jumps costs what
    // it jumped. So "fr" prefers "Find & Replace" over "Refresh Schema Cache".
    total += previous === -1 ? found : found - previous - 1;
    previous = found;
    at = found + 1;
  }
  return total;
}

/** The actions matching a query, best first. */
export function search(query: string, actions: Action[] = ACTIONS): Action[] {
  // Nothing typed yet: keep the order they are declared in, which is the order
  // of the menus. Sorting alphabetically would open the palette on "About
  // SQLPilot", which is a strange thing to offer someone first.
  if (!query.trim()) return [...actions];

  return actions
    .map((action) => ({ action, rank: score(action, query) }))
    .filter((entry): entry is { action: Action; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.action.label.localeCompare(b.action.label))
    .map((entry) => entry.action);
}
