import {
  BarChart3,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Cog,
  Columns3,
  Copy,
  Database,
  Eraser,
  Eye,
  FilePlus,
  FileText,
  FunctionSquare,
  HardDriveDownload,
  HardDriveUpload,
  Loader2,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useClickHandler } from "../../hooks/useClickHandler";
import { useContextMenu } from "../../hooks/useContextMenu";
import { connectionKind } from "../../lib/datasource";
import { runStatement } from "../../lib/run-statement";
import {
  createDatabase,
  databaseStatistics,
  dropDatabase,
  dropTable,
  duplicateTableStructure,
  insertTemplate,
  isValidObjectName,
  renameTable,
  selectTopRows,
  selectTopRowsLabel,
  truncateTable,
} from "../../lib/schema-actions";
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { confirmDrop, confirmTruncate } from "../../stores/productionGuardStore";
import { confirmDestructive } from "../../stores/productionGuardStore";
import { useResultStore } from "../../stores/resultStore";
import { loadKey, type SchemaFolder, schemaFor, useSchemaStore } from "../../stores/schemaStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { DdlObjectType } from "../../types";
import type { MenuItem } from "../common/ContextMenu";
import { FolderNode } from "./FolderNode";
import { HighlightedName } from "./HighlightedName";
import { useTreeNavigation } from "./useTreeNavigation";

export function SchemaTree({ connectionId }: { connectionId: string }) {
  // Whatever backend this connection belongs to. The tree asks it for
  // databases, tables and the rest, and gets the same shapes back either way,
  // so nothing below here knows or cares which one answered (#461).

  // The schema itself lives in a store keyed by connection, so two servers
  // with a database of the same name cannot show each other's objects and a
  // refresh reaches what is on screen (#288, #289).
  const schema = useSchemaStore((s) => schemaFor(s, connectionId));
  const allDatabases = schema.databases ?? [];
  const { tables, views, routines, triggers, events } = schema;

  // FR-4.1.6. The server's own schemas were filtered out in the query, so
  // `mysql` and `information_schema` were unreachable at any price — wrong for
  // a tool whose users administer the server (#291).
  const showSystemDatabases = useSettingsStore((s) => s.querySettings.showSystemDatabases);
  const setQuerySettings = useSettingsStore((s) => s.setQuerySettings);

  // Expansion is the tree's own, but it is still per-connection: the same
  // database name on another server is a different node.
  const [expandedByConnection, setExpandedByConnection] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [expandedFoldersByConnection, setExpandedFoldersByConnection] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const expanded = expandedByConnection[connectionId] ?? {};
  const expandedFolders = expandedFoldersByConnection[connectionId] ?? {};
  const databases = showSystemDatabases
    ? allDatabases
    : allDatabases.filter((d) => !d.is_system);

  const setExpanded = (fn: (prev: Record<string, boolean>) => Record<string, boolean>) =>
    setExpandedByConnection((prev) => ({ ...prev, [connectionId]: fn(prev[connectionId] ?? {}) }));
  const setExpandedFolders = (fn: (prev: Record<string, boolean>) => Record<string, boolean>) =>
    setExpandedFoldersByConnection((prev) => ({
      ...prev,
      [connectionId]: fn(prev[connectionId] ?? {}),
    }));

  const [filterText, setFilterText] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);
  const addTab = useEditorStore((s) => s.addTab);
  const addStructureTab = useEditorStore((s) => s.addStructureTab);
  const addRoutineTab = useEditorStore((s) => s.addRoutineTab);
  const openTab = useEditorStore((s) => s.openTab);
  const addDesignerTab = useEditorStore((s) => s.addDesignerTab);
  const updateTabContent = useEditorStore((s) => s.updateTabContent);
  const setTabDirty = useEditorStore((s) => s.setTabDirty);
  const renameTab = useEditorStore((s) => s.renameTab);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const setTabConnection = useEditorStore((s) => s.setTabConnection);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const executeQuery = useResultStore((s) => s.executeQuery);
  const { contextMenu, showContextMenu } = useContextMenu();
  const activeConnections = useConnectionStore((s) => s.activeConnections);

  // The database queries run against: the active tab's, or else the
  // connection's default, as the status bar shows it. Reading only the tab
  // left the default unmarked and still offered "Set as Default" (#829).
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const connectionDefault = activeConnections.find((c) => c.id === connectionId)?.database;
  const selectedDb = activeTab?.database || connectionDefault || null;

  // Set the active tab's database context to the given DB
  const selectDatabase = (dbName: string) => {
    if (!activeTabId) return;
    const conn = activeConnections.find((c) => c.id === connectionId);
    setTabConnection(activeTabId, connectionId, dbName, conn?.profile_id);
  };

  // Tracks pending single-click timers keyed by "db.name"
  const makeClickHandler = useClickHandler();

  // Insert a backtick-quoted name at the active editor cursor
  const insertNameAtCursor = (name: string) => {
    const editor = useEditorStore.getState().editorInstance;
    if (!editor) return;
    const selection = editor.getSelection();
    if (!selection) return;
    editor.executeEdits("insert-name", [{ range: selection, text: `\`${name}\`` }]);
    editor.focus();
  };

  useEffect(() => {
    void useSchemaStore.getState().ensureDatabases(connectionId);
  }, [connectionId]);

  // Ctrl+Shift+O focuses the schema tree filter input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "O" || e.key === "o")) {
        e.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // With a filter active, everything has to be loaded for the search to be
  // complete. Cancellation is the store's job now — a response for a
  // connection the user has left is dropped there rather than here.
  const filterActive = filterText.trim().length > 0;
  // Keyed by the names, not the array: `databases` is rebuilt every render,
  // and each load below re-renders the tree. Keyed by the array, the effect
  // restarted on every one of those renders, and a load that failed (and so
  // was never cached) was retried in a loop that never ended.
  const databaseNames = databases.map((d) => d.name).join("\u0000");
  useEffect(() => {
    if (!filterActive || databases.length === 0) return;
    let cancelled = false;
    void (async () => {
      const store = useSchemaStore.getState();
      for (const db of databases) {
        if (cancelled) break;
        await store.ensureTables(connectionId, db.name);
        await store.ensureViews(connectionId, db.name);
        await store.ensureRoutines(connectionId, db.name);
        await store.ensureTriggers(connectionId, db.name);
        await store.ensureEvents(connectionId, db.name);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterActive, databaseNames, connectionId]);

  const toggleDb = async (dbName: string) => {
    const isExpanded = expanded[dbName];
    setExpanded((prev) => ({ ...prev, [dbName]: !isExpanded }));
    if (!isExpanded) await useSchemaStore.getState().ensureTables(connectionId, dbName);
  };

  const folderKey = (dbName: string, folder: string) => `${dbName}:${folder}`;

  /**
   * Start a drag carrying a SQL identifier.
   *
   * FR-4.1.4. Double-click already inserted a table name at the cursor, but
   * only for tables and views, and only at the cursor — dragging is how you
   * put a name somewhere specific, and how you reach a function or an event
   * at all (#291).
   *
   * The payload is `text/plain`, which is what Monaco's own drop handling
   * reads, so the editor needs no change to accept it.
   */
  const startDrag = (e: React.DragEvent, text: string) => {
    e.dataTransfer.setData("text/plain", text);
    e.dataTransfer.effectAllowed = "copy";
  };

  /** Whether a node is waiting on the server, for its spinner. */
  const isLoading = (key: string) => schema.loading.includes(key);

  /**
   * Procedures and functions are two folders over one fetch.
   *
   * The server returns both from `listRoutines`, so they share a cache entry
   * and an invalidation; only the display splits them.
   */
  const folderStoreKey = (folder: string): SchemaFolder =>
    folder === "views" || folder === "triggers" || folder === "tables" || folder === "events"
      ? folder
      : "routines";

  const toggleFolder = async (dbName: string, folder: string) => {
    const key = folderKey(dbName, folder);
    const isExpanded = expandedFolders[key];
    setExpandedFolders((prev) => ({ ...prev, [key]: !isExpanded }));
    if (isExpanded) return;

    const store = useSchemaStore.getState();
    if (folder === "views") await store.ensureViews(connectionId, dbName);
    else if (folder === "triggers") await store.ensureTriggers(connectionId, dbName);
    else if (folder === "events") await store.ensureEvents(connectionId, dbName);
    else await store.ensureRoutines(connectionId, dbName);
  };

  const { maxResultRows } = useSettingsStore.getState().querySettings;

  /**
   * A table's or view's rows, in a query tab of its own named after it.
   *
   * The click used to run its SELECT into whatever tab was open, replacing
   * that query's results with a grid nothing named and an editor that did not
   * match it (#829). The tab holds the statement, so the grid says what it is,
   * and clicking the same object again reuses the tab while its SQL is
   * untouched.
   */
  const openObjectData = (dbName: string, name: string) => {
    const sql = selectTopRows(dbName, name, maxResultRows);
    const title = `${dbName}.${name}`;
    const reusable = useEditorStore.getState().tabs.find((t) =>
      t.type === "query" && t.connectionId === connectionId && t.title === title && t.content === sql
    );
    let tabId: string;
    if (reusable) {
      tabId = reusable.id;
      setActiveTab(tabId);
    } else {
      tabId = addTab(connectionId, dbName);
      updateTabContent(tabId, sql);
      // Generated, not typed: closing it loses nothing worth asking about.
      setTabDirty(tabId, false);
      renameTab(tabId, title);
    }
    // On the tab's own session, so the results are filed under it (#842).
    void executeQuery(connectionId, sql, dbName, tabId);
  };

  // Single click: open the rows in their own tab.
  // Double click (within 250ms): insert the name at the cursor instead.
  const handleTableClick = (dbName: string, tableName: string) =>
    makeClickHandler(
      `${dbName}.${tableName}`,
      () => openObjectData(dbName, tableName),
      () => insertNameAtCursor(tableName),
    );

  const handleViewClick = (dbName: string, viewName: string) =>
    makeClickHandler(
      `${dbName}.${viewName}`,
      () => openObjectData(dbName, viewName),
      () => insertNameAtCursor(viewName),
    );

  const openDdlTab = (dbName: string, _objectName: string, ddlQuery: string) => {
    const tabId = addTab(connectionId, dbName);
    updateTabContent(tabId, ddlQuery);
    // On the new tab's session, so its results are filed under it, as a run
    // from its own editor would be (#842).
    void executeQuery(connectionId, ddlQuery, undefined, tabId);
  };

  /**
   * The object's DDL in its own read-only tab, reused on repeat. Running
   * `SHOW CREATE` instead left it ellipsized in one grid cell and opened a new
   * dirty query tab per click (#800). Events have no DDL command yet, so they
   * still go through `openDdlTab`.
   */
  const openDdlView = (dbName: string, objectName: string, objectType: DdlObjectType) => {
    // With its profile, like a query tab: the startup reconnect re-points only
    // tabs that carry one, so without it a restored DDL tab kept the old
    // session's connection id and said "Connection not found".
    const profileId = activeConnections.find((c) => c.id === connectionId)?.profile_id;
    openTab("ddl", { connectionId, database: dbName, objectName, objectType, profileId });
  };

  /**
   * Run a statement that changes the schema, then reload what it changed.
   *
   * Not through `resultStore.executeQuery`, which returns as soon as it opens
   * the production confirmation — so the `.then(refresh)` the menus used ran
   * against unchanged data, and when the user did confirm, nothing refreshed
   * at all. This awaits the answer (#293).
   */
  const runSchemaChange = async (
    sql: string,
    action: string,
    after: () => void | Promise<void>,
  ) => {
    if (!(await confirmDestructive({ connectionId, sql, action, detail: sql }))) return;
    try {
      await runStatement({ connectionId, sql, origin: "schema" });
      await after();
    } catch (e) {
      // Surfaced where the user is looking rather than swallowed: a DROP that
      // silently did nothing is the worst of both outcomes.
      window.alert(String(e));
    }
  };

  /** Ask for a name, refusing one that is not usable. */
  const askForName = (prompt: string, initial = ""): string | null => {
    const answer = window.prompt(prompt, initial);
    if (answer === null) return null;
    if (!isValidObjectName(answer)) {
      window.alert("That name cannot be used. Names are 1-64 characters and cannot span lines.");
      return null;
    }
    return answer.trim();
  };

  /** Put a statement in a new tab without running it. */
  const openInEditor = (dbName: string, sql: string) => {
    const tabId = addTab(connectionId, dbName);
    updateTabContent(tabId, sql);
  };

  /**
   * Refresh a whole database: every folder under it, not only its tables.
   *
   * Reloading tables alone is what left views, routines and triggers showing
   * what the server had when the node was first opened (#289).
   */
  const refreshDatabase = async (dbName: string) => {
    const store = useSchemaStore.getState();
    store.invalidate(connectionId, dbName);
    await store.ensureTables(connectionId, dbName);
    // Only what is on screen: an unopened folder will fetch when it opens.
    if (expandedFolders[folderKey(dbName, "views")]) {
      await store.ensureViews(connectionId, dbName);
    }
    if (
      expandedFolders[folderKey(dbName, "procedures")]
      || expandedFolders[folderKey(dbName, "functions")]
    ) {
      await store.ensureRoutines(connectionId, dbName);
    }
    if (expandedFolders[folderKey(dbName, "triggers")]) {
      await store.ensureTriggers(connectionId, dbName);
    }
    if (expandedFolders[folderKey(dbName, "events")]) {
      await store.ensureEvents(connectionId, dbName);
    }
  };

  const refreshFolder = async (dbName: string, folder: string) => {
    const store = useSchemaStore.getState();
    const which = folderStoreKey(folder);
    store.invalidate(connectionId, dbName, which);
    if (which === "views") await store.ensureViews(connectionId, dbName);
    else if (which === "triggers") await store.ensureTriggers(connectionId, dbName);
    else if (which === "events") await store.ensureEvents(connectionId, dbName);
    else if (which === "routines") await store.ensureRoutines(connectionId, dbName);
    else await store.ensureTables(connectionId, dbName);
  };

  /**
   * "New Table…", for the database menu and the Tables folder: the designer's
   * create mode was unreachable from anywhere (#818). Not offered for SQLite,
   * whose tables the designer's MySQL DDL cannot create.
   */
  const newTableItem = (dbName: string): MenuItem[] =>
    connectionKind(connectionId) === "sqlite" ? [] : [{
      label: "New Table…",
      icon: <Plus className="h-3.5 w-3.5" />,
      onClick: () => addDesignerTab(connectionId, dbName),
    }];

  const isFolderExpanded = (dbName: string, folder: string) => !!expandedFolders[folderKey(dbName, folder)];

  // --- Filter helpers ---
  const filterLower = filterText.toLowerCase().trim();
  const isFiltering = filterLower.length > 0;
  const matchItem = (name: string) => name.toLowerCase().includes(filterLower);

  const filteredTables = (dbName: string) => {
    const all = tables[dbName]?.filter((t) => t.table_type !== "VIEW") ?? [];
    return isFiltering ? all.filter((t) => matchItem(t.name)) : all;
  };
  const filteredViews = (dbName: string) => {
    const all = views[dbName] ?? [];
    return isFiltering ? all.filter((v) => matchItem(v.name)) : all;
  };
  const filteredProcedures = (dbName: string) => {
    const all = routines[dbName]?.filter((r) => r.routine_type === "PROCEDURE") ?? [];
    return isFiltering ? all.filter((r) => matchItem(r.name)) : all;
  };
  const filteredFunctions = (dbName: string) => {
    const all = routines[dbName]?.filter((r) => r.routine_type === "FUNCTION") ?? [];
    return isFiltering ? all.filter((r) => matchItem(r.name)) : all;
  };
  const filteredTriggers = (dbName: string) => {
    const all = triggers[dbName] ?? [];
    return isFiltering ? all.filter((t) => matchItem(t.name)) : all;
  };
  const filteredEvents = (dbName: string) => {
    const all = events[dbName] ?? [];
    return isFiltering ? all.filter((e) => matchItem(e.name)) : all;
  };

  const dbHasMatches = (dbName: string) =>
    filteredTables(dbName).length > 0
    || filteredViews(dbName).length > 0
    || filteredProcedures(dbName).length > 0
    || filteredFunctions(dbName).length > 0
    || filteredTriggers(dbName).length > 0
    || filteredEvents(dbName).length > 0;

  // Show all DBs while filtering; hide only those whose data IS loaded and has no matches
  const isDbVisible = (dbName: string) => !isFiltering || tables[dbName] === undefined || dbHasMatches(dbName);
  const visibleDatabases = databases.filter((db) => isDbVisible(db.name));

  // Auto-expand when matches found; also respect manual toggles while filtering
  const isDbExpanded = (dbName: string) =>
    isFiltering
      ? !!expanded[dbName] || (tables[dbName] !== undefined && dbHasMatches(dbName))
      : !!expanded[dbName];

  // When filtering, hide empty folders and auto-expand folders with matches;
  // also respect manual folder toggles
  const isFolderVisible = (count: number) => !isFiltering || count > 0;
  const isFolderExpandedFiltered = (dbName: string, folder: string, filteredCount: number) =>
    isFiltering
      ? isFolderExpanded(dbName, folder) || filteredCount > 0
      : isFolderExpanded(dbName, folder);

  // Up, Down, Home and End across the rows on screen, one tab stop (#823).
  const firstDb = visibleDatabases[0];
  const { rowProps, treeProps } = useTreeNavigation(firstDb ? `db:${firstDb.name}` : null);

  return (
    <div className="ml-4 border-l border-[var(--color-border)] pl-1">
      {/* Filter input */}
      <div className="relative mb-1 mt-0.5 px-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <input
          ref={filterInputRef}
          type="text"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilterText("")}
          placeholder="Filter (Ctrl+Shift+O)"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-0.5 pl-6 pr-6 text-[11px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-brand-500 focus:outline-none"
        />
        {filterText && (
          <button
            onClick={() => setFilterText("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {
        /* FR-4.1.6: the server's own schemas, on request (#291). Only offered
          when there are some — SQLite has none. */
      }
      {allDatabases.some((d) => d.is_system) && (
        <label className="mb-1 flex cursor-pointer items-center gap-1.5 px-2 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={showSystemDatabases}
            onChange={(e) =>
              setQuerySettings({
                ...useSettingsStore.getState().querySettings,
                showSystemDatabases: e.target.checked,
              })}
            className="h-3 w-3 accent-brand-500"
          />
          Show system databases
        </label>
      )}

      {
        /* Without this a filter that hides everything left a blank tree, which
          reads as "still loading" (#806). */
      }
      {isFiltering && databases.length > 0 && visibleDatabases.length === 0 && (
        <p role="status" className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
          No objects match '{filterText.trim()}'
        </p>
      )}

      {
        /* The tree is the rows only: the filter and the toggle above it are
          not tree items, and a tree containing them is not one a screen
          reader can walk. */
      }
      <div role="tree" aria-label="Schema" {...treeProps}>
        {visibleDatabases.map((db) => (
          <div key={db.name} role="none">
            <button
              role="treeitem"
              aria-expanded={isDbExpanded(db.name)}
              aria-level={1}
              aria-label={db.name}
              {...rowProps(`db:${db.name}`)}
              onKeyDown={(e) => {
                // A tree opens and closes with Left and Right (F3.11 of #299).
                if (e.key === "ArrowRight" && !isDbExpanded(db.name)) {
                  e.preventDefault();
                  void toggleDb(db.name);
                } else if (e.key === "ArrowLeft" && isDbExpanded(db.name)) {
                  e.preventDefault();
                  void toggleDb(db.name);
                }
              }}
              onClick={makeClickHandler(
                `db:${db.name}`,
                () => toggleDb(db.name),
                () => selectDatabase(db.name),
              )}
              onContextMenu={(e) => {
                showContextMenu(e, [
                  {
                    label: "New Query",
                    icon: <FileText className="h-3.5 w-3.5" />,
                    onClick: () => {
                      const tabId = addTab(connectionId, db.name);
                      updateTabContent(tabId, `USE \`${db.name}\`;\n`);
                    },
                  },
                  ...newTableItem(db.name),
                  {
                    label: "Refresh",
                    icon: <RefreshCw className="h-3.5 w-3.5" />,
                    onClick: () => refreshDatabase(db.name),
                  },
                  {
                    // FR-4.3.2. Which database new tabs open against, which the
                    // tree could show but not set (#293).
                    label: selectedDb === db.name ? "Already the default" : "Set as Default",
                    icon: <Check className="h-3.5 w-3.5" />,
                    disabled: selectedDb === db.name,
                    onClick: () => selectDatabase(db.name),
                  },
                  {
                    label: "Statistics",
                    icon: <BarChart3 className="h-3.5 w-3.5" />,
                    onClick: () => openDdlTab(db.name, db.name, databaseStatistics(db.name)),
                  },
                  { separator: true },
                  {
                    label: "Create Database…",
                    icon: <Database className="h-3.5 w-3.5" />,
                    onClick: () => {
                      const name = askForName("Name for the new database:");
                      if (!name) return;
                      void runSchemaChange(
                        createDatabase(name),
                        `Create database \`${name}\`?`,
                        async () => {
                          // The list itself changed, not one database's contents.
                          useSchemaStore.getState().invalidate(connectionId);
                          await useSchemaStore.getState().ensureDatabases(connectionId);
                        },
                      );
                    },
                  },
                  {
                    label: "Drop Database",
                    icon: <Trash2 className="h-3.5 w-3.5" />,
                    danger: true,
                    onClick: () => {
                      // Typed rather than clicked: dropping a database takes
                      // every table in it, and a misplaced click should not be
                      // able to do that.
                      const typed = window.prompt(
                        `This drops \`${db.name}\` and everything in it. `
                          + `Type the database name to confirm:`,
                      );
                      if (typed !== db.name) return;
                      void runSchemaChange(
                        dropDatabase(db.name),
                        `Drop database \`${db.name}\` and every table in it?`,
                        async () => {
                          useSchemaStore.getState().invalidate(connectionId);
                          await useSchemaStore.getState().ensureDatabases(connectionId);
                        },
                      );
                    },
                  },
                  { separator: true },
                  {
                    label: "Backup Database",
                    icon: <HardDriveDownload className="h-3.5 w-3.5" />,
                    onClick: () => {
                      window.dispatchEvent(
                        new CustomEvent("open-backup", {
                          detail: { connectionId, database: db.name },
                        }),
                      );
                    },
                  },
                  {
                    label: "Restore to Database",
                    icon: <HardDriveUpload className="h-3.5 w-3.5" />,
                    onClick: () => {
                      window.dispatchEvent(
                        new CustomEvent("open-restore", {
                          detail: { connectionId, database: db.name },
                        }),
                      );
                    },
                  },
                ]);
              }}
              className={cn(
                "flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:text-[var(--color-text-secondary)]",
                selectedDb === db.name
                  ? "font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)]",
              )}
            >
              {isDbExpanded(db.name) ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <Database className={cn("h-3 w-3", selectedDb === db.name && "text-[var(--color-accent)]")} />
              <span>{db.name}</span>
              {selectedDb === db.name && (
                <span className="ml-auto text-[9px] text-[var(--color-accent)] opacity-75">●</span>
              )}
            </button>
            {isDbExpanded(db.name) && (
              <div role="group" className="ml-3">
                {isLoading(loadKey(db.name)) && !tables[db.name] && (
                  <div className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-[var(--color-text-muted)]">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading...
                  </div>
                )}
                {/* Tables folder */}
                {isFolderVisible(filteredTables(db.name).length) && (
                  <FolderNode
                    label="Tables"
                    rowProps={rowProps(folderKey(db.name, "tables"))}
                    icon={<Table2 className="h-3 w-3" />}
                    isExpanded={isFolderExpandedFiltered(db.name, "tables", filteredTables(db.name).length)}
                    onToggle={() => toggleFolder(db.name, "tables")}
                    onContextMenu={(e) => {
                      showContextMenu(e, [
                        ...newTableItem(db.name),
                        {
                          label: "Refresh",
                          icon: <RefreshCw className="h-3.5 w-3.5" />,
                          onClick: () => refreshDatabase(db.name),
                        },
                      ]);
                    }}
                    count={tables[db.name]?.filter((t) => t.table_type !== "VIEW").length}
                  >
                    {filteredTables(db.name).map((t) => (
                      <div
                        key={t.name}
                        role="none"
                        className="group/table flex items-center rounded hover:bg-[var(--color-bg-tertiary)]"
                      >
                        <button
                          role="treeitem"
                          aria-level={3}
                          {...rowProps(`${folderKey(db.name, "tables")}:${t.name}`)}
                          // FR-4.1.4 (#291).
                          draggable
                          onDragStart={(e) => startDrag(e, `\`${db.name}\`.\`${t.name}\``)}
                          onClick={handleTableClick(db.name, t.name)}
                          onContextMenu={(e) => {
                            showContextMenu(e, [
                              {
                                // Named for the limit it actually uses (#293).
                                label: selectTopRowsLabel(maxResultRows),
                                icon: <Search className="h-3.5 w-3.5" />,
                                onClick: () => openObjectData(db.name, t.name),
                              },
                              {
                                label: "View Structure",
                                icon: <Columns3 className="h-3.5 w-3.5" />,
                                onClick: () => addStructureTab(connectionId, db.name, t.name),
                              },
                              {
                                label: "Design Table",
                                icon: <PenLine className="h-3.5 w-3.5" />,
                                onClick: () => addDesignerTab(connectionId, db.name, t.name),
                              },
                              {
                                label: "Copy Name",
                                icon: <Copy className="h-3.5 w-3.5" />,
                                onClick: () => {
                                  void navigator.clipboard.writeText(t.name);
                                },
                              },
                              {
                                label: "Show DDL",
                                icon: <FileText className="h-3.5 w-3.5" />,
                                onClick: () => openDdlView(db.name, t.name, "TABLE"),
                              },
                              {
                                // Opened rather than run: an INSERT with every
                                // value left NULL is a starting point, not a
                                // statement anyone means to execute (#293).
                                label: "INSERT Template",
                                icon: <FilePlus className="h-3.5 w-3.5" />,
                                onClick: () => {
                                  void useSchemaStore
                                    .getState()
                                    .ensureColumns(connectionId, db.name, t.name)
                                    .then((cols) => openInEditor(db.name, insertTemplate(db.name, t.name, cols)));
                                },
                              },
                              { separator: true },
                              {
                                label: "Rename Table…",
                                icon: <PenLine className="h-3.5 w-3.5" />,
                                onClick: () => {
                                  const name = askForName(`Rename \`${t.name}\` to:`, t.name);
                                  if (!name || name === t.name) return;
                                  void runSchemaChange(
                                    renameTable(db.name, t.name, name),
                                    `Rename \`${t.name}\` to \`${name}\`?`,
                                    () => refreshFolder(db.name, "tables"),
                                  );
                                },
                              },
                              {
                                label: "Duplicate Structure…",
                                icon: <Copy className="h-3.5 w-3.5" />,
                                onClick: () => {
                                  const name = askForName("Name for the copy:", `${t.name}_copy`);
                                  if (!name) return;
                                  void runSchemaChange(
                                    duplicateTableStructure(db.name, t.name, name),
                                    `Create \`${name}\` with the same structure as \`${t.name}\`?`,
                                    () => refreshFolder(db.name, "tables"),
                                  );
                                },
                              },
                              { separator: true },
                              {
                                label: "Truncate Table",
                                icon: <Eraser className="h-3.5 w-3.5" />,
                                danger: true,
                                onClick: async () => {
                                  // Asked here off production; on production the
                                  // guard in runSchemaChange asks instead.
                                  const subject = `\`${db.name}\`.\`${t.name}\``;
                                  if (!(await confirmTruncate(connectionId, subject))) return;
                                  await runSchemaChange(
                                    truncateTable(db.name, t.name),
                                    // TRUNCATE is not transactional and takes
                                    // every row; the confirmation has to say so.
                                    `Delete every row in \`${db.name}\`.\`${t.name}\`? `
                                      + `TRUNCATE cannot be rolled back.`,
                                    () => refreshFolder(db.name, "tables"),
                                  );
                                },
                              },
                              { separator: true },
                              {
                                label: "Drop Table",
                                icon: <Trash2 className="h-3.5 w-3.5" />,
                                danger: true,
                                onClick: async () => {
                                  if (!(await confirmDrop(connectionId, `table \`${db.name}\`.\`${t.name}\``))) return;
                                  await runSchemaChange(
                                    dropTable(db.name, t.name),
                                    `Drop table \`${db.name}\`.\`${t.name}\`?`,
                                    () => refreshFolder(db.name, "tables"),
                                  );
                                },
                              },
                            ]);
                          }}
                          className="flex flex-1 items-center gap-1 px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        >
                          <Table2 className="h-3 w-3 shrink-0" />
                          <span className="truncate">
                            <HighlightedName name={t.name} match={filterText} />
                          </span>
                          {t.row_count != null && (
                            <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                              ~{t.row_count.toLocaleString()}
                            </span>
                          )}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            addStructureTab(connectionId, db.name, t.name);
                          }}
                          // Out of the tab order: the row is the tree's one stop, and
                          // its context menu (Shift+F10 or the Menu key) has View
                          // Structure. It shows while the row has keyboard focus, so
                          // the shortcut is not hover-only either (#784).
                          tabIndex={-1}
                          title="View Structure"
                          aria-label={`View structure of ${t.name}`}
                          className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 hover:bg-[var(--color-bg-primary)] hover:text-brand-400 group-hover/table:opacity-100 group-has-[:focus-visible]/table:opacity-100"
                        >
                          <Columns3 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </FolderNode>
                )}

                {/* Views folder */}
                {isFolderVisible(filteredViews(db.name).length) && (
                  <FolderNode
                    label="Views"
                    rowProps={rowProps(folderKey(db.name, "views"))}
                    icon={<Eye className="h-3 w-3" />}
                    isExpanded={isFolderExpandedFiltered(db.name, "views", filteredViews(db.name).length)}
                    onToggle={() => toggleFolder(db.name, "views")}
                    loading={isLoading(loadKey(db.name, folderStoreKey("views")))}
                    onContextMenu={(e) => {
                      showContextMenu(e, [
                        {
                          label: "Refresh",
                          icon: <RefreshCw className="h-3.5 w-3.5" />,
                          onClick: () => refreshFolder(db.name, "views"),
                        },
                      ]);
                    }}
                    count={views[db.name]?.length}
                  >
                    {filteredViews(db.name).map((v) => (
                      <button
                        key={v.name}
                        role="treeitem"
                        aria-level={3}
                        {...rowProps(`${folderKey(db.name, "views")}:${v.name}`)}
                        draggable
                        onDragStart={(e) => startDrag(e, `\`${db.name}\`.\`${v.name}\``)}
                        onClick={handleViewClick(db.name, v.name)}
                        onContextMenu={(e) => {
                          showContextMenu(e, [
                            {
                              // The limit it uses, as on tables (#829).
                              label: selectTopRowsLabel(maxResultRows),
                              icon: <Search className="h-3.5 w-3.5" />,
                              onClick: () => openObjectData(db.name, v.name),
                            },
                            {
                              label: "Copy Name",
                              icon: <Copy className="h-3.5 w-3.5" />,
                              onClick: () => {
                                navigator.clipboard.writeText(v.name);
                              },
                            },
                            {
                              label: "Show DDL",
                              icon: <FileText className="h-3.5 w-3.5" />,
                              onClick: () => {
                                openDdlView(db.name, v.name, "VIEW");
                              },
                            },
                            { separator: true },
                            {
                              label: "Drop View",
                              icon: <Trash2 className="h-3.5 w-3.5" />,
                              danger: true,
                              onClick: async () => {
                                // Asked here off production; on production the
                                // guard in runSchemaChange asks instead. Awaited,
                                // so the refresh sees the drop (#829).
                                if (!(await confirmDrop(connectionId, `view \`${db.name}\`.\`${v.name}\``))) return;
                                await runSchemaChange(
                                  `DROP VIEW \`${db.name}\`.\`${v.name}\``,
                                  `Drop view \`${db.name}\`.\`${v.name}\`?`,
                                  () => refreshFolder(db.name, "views"),
                                );
                              },
                            },
                          ]);
                        }}
                        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
                      >
                        <Eye className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          <HighlightedName name={v.name} match={filterText} />
                        </span>
                      </button>
                    ))}
                  </FolderNode>
                )}

                {/* Procedures folder */}
                {isFolderVisible(filteredProcedures(db.name).length) && (
                  <FolderNode
                    label="Procedures"
                    rowProps={rowProps(folderKey(db.name, "procedures"))}
                    icon={<Cog className="h-3 w-3" />}
                    isExpanded={isFolderExpandedFiltered(db.name, "procedures", filteredProcedures(db.name).length)}
                    onToggle={() => toggleFolder(db.name, "procedures")}
                    loading={isLoading(loadKey(db.name, folderStoreKey("procedures")))}
                    onContextMenu={(e) => {
                      showContextMenu(e, [
                        {
                          label: "Refresh",
                          icon: <RefreshCw className="h-3.5 w-3.5" />,
                          onClick: () => refreshFolder(db.name, "routines"),
                        },
                      ]);
                    }}
                    count={routines[db.name]?.filter((r) => r.routine_type === "PROCEDURE").length}
                  >
                    {filteredProcedures(db.name).map((r) => (
                      <button
                        key={r.name}
                        role="treeitem"
                        aria-level={3}
                        {...rowProps(`${folderKey(db.name, "procedures")}:${r.name}`)}
                        draggable
                        onDragStart={(e) => startDrag(e, `\`${db.name}\`.\`${r.name}\``)}
                        onClick={() => addRoutineTab(connectionId, db.name, r.name, "PROCEDURE")}
                        onContextMenu={(e) => {
                          showContextMenu(e, [
                            {
                              label: "Execute",
                              icon: <Play className="h-3.5 w-3.5" />,
                              onClick: () => {
                                addRoutineTab(connectionId, db.name, r.name, "PROCEDURE");
                              },
                            },
                            {
                              label: "Copy Name",
                              icon: <Copy className="h-3.5 w-3.5" />,
                              onClick: () => {
                                navigator.clipboard.writeText(r.name);
                              },
                            },
                            {
                              label: "View DDL",
                              icon: <FileText className="h-3.5 w-3.5" />,
                              onClick: () => {
                                openDdlView(db.name, r.name, "PROCEDURE");
                              },
                            },
                            { separator: true },
                            {
                              label: "Drop Procedure",
                              icon: <Trash2 className="h-3.5 w-3.5" />,
                              danger: true,
                              onClick: async () => {
                                // Asked here off production; on production the
                                // guard in runSchemaChange asks instead. Awaited,
                                // so the refresh sees the drop (#829).
                                if (!(await confirmDrop(connectionId, `procedure \`${db.name}\`.\`${r.name}\``))) {
                                  return;
                                }
                                await runSchemaChange(
                                  `DROP PROCEDURE \`${db.name}\`.\`${r.name}\``,
                                  `Drop procedure \`${db.name}\`.\`${r.name}\`?`,
                                  () => refreshFolder(db.name, "routines"),
                                );
                              },
                            },
                          ]);
                        }}
                        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
                      >
                        <Cog className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          <HighlightedName name={r.name} match={filterText} />
                        </span>
                      </button>
                    ))}
                  </FolderNode>
                )}

                {/* Functions folder */}
                {isFolderVisible(filteredFunctions(db.name).length) && (
                  <FolderNode
                    label="Functions"
                    rowProps={rowProps(folderKey(db.name, "functions"))}
                    icon={<FunctionSquare className="h-3 w-3" />}
                    isExpanded={isFolderExpandedFiltered(db.name, "functions", filteredFunctions(db.name).length)}
                    onToggle={() => toggleFolder(db.name, "functions")}
                    loading={isLoading(loadKey(db.name, folderStoreKey("functions")))}
                    onContextMenu={(e) => {
                      showContextMenu(e, [
                        {
                          label: "Refresh",
                          icon: <RefreshCw className="h-3.5 w-3.5" />,
                          onClick: () => refreshFolder(db.name, "routines"),
                        },
                      ]);
                    }}
                    count={routines[db.name]?.filter((r) => r.routine_type === "FUNCTION").length}
                  >
                    {filteredFunctions(db.name).map((r) => (
                      <button
                        key={r.name}
                        role="treeitem"
                        aria-level={3}
                        {...rowProps(`${folderKey(db.name, "functions")}:${r.name}`)}
                        draggable
                        onDragStart={(e) => startDrag(e, `\`${db.name}\`.\`${r.name}\``)}
                        onClick={() => addRoutineTab(connectionId, db.name, r.name, "FUNCTION")}
                        onContextMenu={(e) => {
                          showContextMenu(e, [
                            {
                              label: "Execute",
                              icon: <Play className="h-3.5 w-3.5" />,
                              onClick: () => {
                                addRoutineTab(connectionId, db.name, r.name, "FUNCTION");
                              },
                            },
                            {
                              label: "Copy Name",
                              icon: <Copy className="h-3.5 w-3.5" />,
                              onClick: () => {
                                navigator.clipboard.writeText(r.name);
                              },
                            },
                            {
                              label: "View DDL",
                              icon: <FileText className="h-3.5 w-3.5" />,
                              onClick: () => {
                                openDdlView(db.name, r.name, "FUNCTION");
                              },
                            },
                            { separator: true },
                            {
                              label: "Drop Function",
                              icon: <Trash2 className="h-3.5 w-3.5" />,
                              danger: true,
                              onClick: async () => {
                                // Asked here off production; on production the
                                // guard in runSchemaChange asks instead. Awaited,
                                // so the refresh sees the drop (#829).
                                if (!(await confirmDrop(connectionId, `function \`${db.name}\`.\`${r.name}\``))) return;
                                await runSchemaChange(
                                  `DROP FUNCTION \`${db.name}\`.\`${r.name}\``,
                                  `Drop function \`${db.name}\`.\`${r.name}\`?`,
                                  () => refreshFolder(db.name, "routines"),
                                );
                              },
                            },
                          ]);
                        }}
                        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
                      >
                        <FunctionSquare className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          <HighlightedName name={r.name} match={filterText} />
                        </span>
                      </button>
                    ))}
                  </FolderNode>
                )}

                {/* Triggers folder */}
                {isFolderVisible(filteredTriggers(db.name).length) && (
                  <FolderNode
                    label="Triggers"
                    rowProps={rowProps(folderKey(db.name, "triggers"))}
                    icon={<Zap className="h-3 w-3" />}
                    isExpanded={isFolderExpandedFiltered(db.name, "triggers", filteredTriggers(db.name).length)}
                    onToggle={() => toggleFolder(db.name, "triggers")}
                    loading={isLoading(loadKey(db.name, folderStoreKey("triggers")))}
                    onContextMenu={(e) => {
                      showContextMenu(e, [
                        {
                          label: "Refresh",
                          icon: <RefreshCw className="h-3.5 w-3.5" />,
                          onClick: () => refreshFolder(db.name, "triggers"),
                        },
                      ]);
                    }}
                    count={triggers[db.name]?.length}
                  >
                    {filteredTriggers(db.name).map((t) => (
                      <button
                        key={t.name}
                        role="treeitem"
                        aria-level={3}
                        {...rowProps(`${folderKey(db.name, "triggers")}:${t.name}`)}
                        draggable
                        onDragStart={(e) => startDrag(e, `\`${db.name}\`.\`${t.name}\``)}
                        onClick={() => openDdlView(db.name, t.name, "TRIGGER")}
                        onContextMenu={(e) => {
                          showContextMenu(e, [
                            {
                              label: "Copy Name",
                              icon: <Copy className="h-3.5 w-3.5" />,
                              onClick: () => {
                                navigator.clipboard.writeText(t.name);
                              },
                            },
                            {
                              label: "Show DDL",
                              icon: <FileText className="h-3.5 w-3.5" />,
                              onClick: () => {
                                openDdlView(db.name, t.name, "TRIGGER");
                              },
                            },
                            { separator: true },
                            {
                              label: "Drop Trigger",
                              icon: <Trash2 className="h-3.5 w-3.5" />,
                              danger: true,
                              onClick: async () => {
                                // Asked here off production; on production the
                                // guard in runSchemaChange asks instead. Awaited,
                                // so the refresh sees the drop (#829).
                                if (!(await confirmDrop(connectionId, `trigger \`${db.name}\`.\`${t.name}\``))) return;
                                await runSchemaChange(
                                  `DROP TRIGGER \`${db.name}\`.\`${t.name}\``,
                                  `Drop trigger \`${db.name}\`.\`${t.name}\`?`,
                                  () => refreshFolder(db.name, "triggers"),
                                );
                              },
                            },
                          ]);
                        }}
                        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
                      >
                        <Zap className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          <HighlightedName name={t.name} match={filterText} />
                        </span>
                        <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                          {t.timing} {t.event}
                        </span>
                      </button>
                    ))}
                  </FolderNode>
                )}

                {/* Events folder (FR-4.1.1, #291) */}
                {isFolderVisible(filteredEvents(db.name).length) && (
                  <FolderNode
                    label="Events"
                    rowProps={rowProps(folderKey(db.name, "events"))}
                    icon={<CalendarClock className="h-3 w-3" />}
                    isExpanded={isFolderExpandedFiltered(db.name, "events", filteredEvents(db.name).length)}
                    onToggle={() => toggleFolder(db.name, "events")}
                    loading={isLoading(loadKey(db.name, "events"))}
                    onContextMenu={(e) => {
                      showContextMenu(e, [
                        {
                          label: "Refresh",
                          icon: <RefreshCw className="h-3.5 w-3.5" />,
                          onClick: () => refreshFolder(db.name, "events"),
                        },
                      ]);
                    }}
                    count={events[db.name]?.length}
                  >
                    {filteredEvents(db.name).map((ev) => (
                      <button
                        key={ev.name}
                        role="treeitem"
                        aria-level={3}
                        {...rowProps(`${folderKey(db.name, "events")}:${ev.name}`)}
                        draggable
                        onDragStart={(e) => startDrag(e, `\`${db.name}\`.\`${ev.name}\``)}
                        onClick={() => openDdlTab(db.name, ev.name, `SHOW CREATE EVENT \`${db.name}\`.\`${ev.name}\``)}
                        onContextMenu={(e) => {
                          showContextMenu(e, [
                            {
                              label: "Copy Name",
                              icon: <Copy className="h-3.5 w-3.5" />,
                              onClick: () => {
                                void navigator.clipboard.writeText(ev.name);
                              },
                            },
                            {
                              label: "Show DDL",
                              icon: <FileText className="h-3.5 w-3.5" />,
                              onClick: () =>
                                openDdlTab(db.name, ev.name, `SHOW CREATE EVENT \`${db.name}\`.\`${ev.name}\``),
                            },
                            {
                              // An event that is off is the usual reason one did
                              // not run, and turning it back on is a statement
                              // nobody remembers the syntax of.
                              label: ev.status === "ENABLED" ? "Disable Event" : "Enable Event",
                              icon: <CalendarClock className="h-3.5 w-3.5" />,
                              onClick: () =>
                                void runSchemaChange(
                                  `ALTER EVENT \`${db.name}\`.\`${ev.name}\` ${
                                    ev.status === "ENABLED" ? "DISABLE" : "ENABLE"
                                  }`,
                                  `${
                                    ev.status === "ENABLED" ? "Disable" : "Enable"
                                  } event \`${db.name}\`.\`${ev.name}\`?`,
                                  () => refreshFolder(db.name, "events"),
                                ),
                            },
                            { separator: true },
                            {
                              label: "Drop Event",
                              icon: <Trash2 className="h-3.5 w-3.5" />,
                              danger: true,
                              onClick: async () => {
                                // Asked here off production; on production the
                                // guard in runSchemaChange asks instead. Awaited,
                                // so the refresh sees the drop (#829).
                                if (!(await confirmDrop(connectionId, `event \`${db.name}\`.\`${ev.name}\``))) return;
                                await runSchemaChange(
                                  `DROP EVENT \`${db.name}\`.\`${ev.name}\``,
                                  `Drop event \`${db.name}\`.\`${ev.name}\`?`,
                                  () => refreshFolder(db.name, "events"),
                                );
                              },
                            },
                          ]);
                        }}
                        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
                      >
                        <CalendarClock className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          <HighlightedName name={ev.name} match={filterText} />
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">
                          {ev.status === "ENABLED" ? (ev.interval || "once") : "off"}
                        </span>
                      </button>
                    ))}
                  </FolderNode>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {contextMenu}
    </div>
  );
}
