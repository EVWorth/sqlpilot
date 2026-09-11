import {
  ChevronDown,
  ChevronRight,
  Cog,
  Columns3,
  Copy,
  Database,
  Eye,
  FileText,
  FunctionSquare,
  HardDriveDownload,
  HardDriveUpload,
  Loader2,
  PenLine,
  Play,
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
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { loadKey, type SchemaFolder, schemaFor, useSchemaStore } from "../../stores/schemaStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { FolderNode } from "./FolderNode";

export function SchemaTree({ connectionId }: { connectionId: string }) {
  // Whatever backend this connection belongs to. The tree asks it for
  // databases, tables and the rest, and gets the same shapes back either way,
  // so nothing below here knows or cares which one answered (#461).

  // The schema itself lives in a store keyed by connection, so two servers
  // with a database of the same name cannot show each other's objects and a
  // refresh reaches what is on screen (#288, #289).
  const schema = useSchemaStore((s) => schemaFor(s, connectionId));
  const databases = schema.databases ?? [];
  const { tables, views, routines, triggers } = schema;

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
  const addDesignerTab = useEditorStore((s) => s.addDesignerTab);
  const updateTabContent = useEditorStore((s) => s.updateTabContent);
  const setTabConnection = useEditorStore((s) => s.setTabConnection);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const executeQuery = useResultStore((s) => s.executeQuery);
  const { contextMenu, showContextMenu } = useContextMenu();
  const activeConnections = useConnectionStore((s) => s.activeConnections);

  // Derive the selected database from the active tab
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const selectedDb = activeTab?.database ?? null;

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
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterActive, databases, connectionId]);

  const toggleDb = async (dbName: string) => {
    const isExpanded = expanded[dbName];
    setExpanded((prev) => ({ ...prev, [dbName]: !isExpanded }));
    if (!isExpanded) await useSchemaStore.getState().ensureTables(connectionId, dbName);
  };

  const folderKey = (dbName: string, folder: string) => `${dbName}:${folder}`;

  /** Whether a node is waiting on the server, for its spinner. */
  const isLoading = (key: string) => schema.loading.includes(key);

  /**
   * Procedures and functions are two folders over one fetch.
   *
   * The server returns both from `listRoutines`, so they share a cache entry
   * and an invalidation; only the display splits them.
   */
  const folderStoreKey = (folder: string): SchemaFolder =>
    folder === "views"
      ? "views"
      : folder === "triggers"
      ? "triggers"
      : folder === "tables"
      ? "tables"
      : "routines";

  const toggleFolder = async (dbName: string, folder: string) => {
    const key = folderKey(dbName, folder);
    const isExpanded = expandedFolders[key];
    setExpandedFolders((prev) => ({ ...prev, [key]: !isExpanded }));
    if (isExpanded) return;

    const store = useSchemaStore.getState();
    if (folder === "views") await store.ensureViews(connectionId, dbName);
    else if (folder === "triggers") await store.ensureTriggers(connectionId, dbName);
    else await store.ensureRoutines(connectionId, dbName);
  };

  // Single click: run SELECT inline without touching the editor tab
  // Double click (within 250ms): insert table name at cursor instead
  const { maxResultRows } = useSettingsStore.getState().querySettings;
  const handleTableClick = (dbName: string, tableName: string) =>
    makeClickHandler(
      `${dbName}.${tableName}`,
      () => executeQuery(connectionId, `SELECT * FROM \`${dbName}\`.\`${tableName}\` LIMIT ${maxResultRows}`, dbName),
      () => insertNameAtCursor(tableName),
    );

  const handleViewClick = (dbName: string, viewName: string) =>
    makeClickHandler(
      `${dbName}.${viewName}`,
      () => executeQuery(connectionId, `SELECT * FROM \`${dbName}\`.\`${viewName}\` LIMIT ${maxResultRows}`, dbName),
      () => insertNameAtCursor(viewName),
    );

  const openDdlTab = (dbName: string, _objectName: string, ddlQuery: string) => {
    const tabId = addTab(connectionId, dbName);
    updateTabContent(tabId, ddlQuery);
    executeQuery(connectionId, ddlQuery);
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
  };

  const refreshFolder = async (dbName: string, folder: string) => {
    const store = useSchemaStore.getState();
    const which = folderStoreKey(folder);
    store.invalidate(connectionId, dbName, which);
    if (which === "views") await store.ensureViews(connectionId, dbName);
    else if (which === "triggers") await store.ensureTriggers(connectionId, dbName);
    else if (which === "routines") await store.ensureRoutines(connectionId, dbName);
    else await store.ensureTables(connectionId, dbName);
  };

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

  const dbHasMatches = (dbName: string) =>
    filteredTables(dbName).length > 0
    || filteredViews(dbName).length > 0
    || filteredProcedures(dbName).length > 0
    || filteredFunctions(dbName).length > 0
    || filteredTriggers(dbName).length > 0;

  // Show all DBs while filtering; hide only those whose data IS loaded and has no matches
  const isDbVisible = (dbName: string) => !isFiltering || tables[dbName] === undefined || dbHasMatches(dbName);

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
          placeholder="Filter (Ctrl+Shift+F)"
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
      {databases.filter((db) => isDbVisible(db.name)).map((db) => (
        <div key={db.name}>
          <button
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
                {
                  label: "Refresh",
                  icon: <RefreshCw className="h-3.5 w-3.5" />,
                  onClick: () => refreshDatabase(db.name),
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
            <div className="ml-3">
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
                  icon={<Table2 className="h-3 w-3" />}
                  isExpanded={isFolderExpandedFiltered(db.name, "tables", filteredTables(db.name).length)}
                  onToggle={() => toggleFolder(db.name, "tables")}
                  onContextMenu={(e) => {
                    showContextMenu(e, [
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
                      className="group/table flex items-center rounded hover:bg-[var(--color-bg-tertiary)]"
                    >
                      <button
                        onClick={handleTableClick(db.name, t.name)}
                        onContextMenu={(e) => {
                          showContextMenu(e, [
                            {
                              label: "Select Top 100 Rows",
                              icon: <Search className="h-3.5 w-3.5" />,
                              onClick: () => {
                                executeQuery(
                                  connectionId,
                                  `SELECT * FROM \`${db.name}\`.\`${t.name}\` LIMIT ${maxResultRows}`,
                                  db.name,
                                );
                              },
                            },
                            {
                              label: "View Structure",
                              icon: <Columns3 className="h-3.5 w-3.5" />,
                              onClick: () => {
                                addStructureTab(connectionId, db.name, t.name);
                              },
                            },
                            {
                              label: "Design Table",
                              icon: <PenLine className="h-3.5 w-3.5" />,
                              onClick: () => {
                                addDesignerTab(connectionId, db.name, t.name);
                              },
                            },
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
                                openDdlTab(db.name, t.name, `SHOW CREATE TABLE \`${db.name}\`.\`${t.name}\``);
                              },
                            },
                            { separator: true },
                            {
                              label: "Drop Table",
                              icon: <Trash2 className="h-3.5 w-3.5" />,
                              danger: true,
                              onClick: () => {
                                if (
                                  window.confirm(
                                    `Are you sure you want to drop table \`${db.name}\`.\`${t.name}\`?`,
                                  )
                                ) {
                                  executeQuery(
                                    connectionId,
                                    `DROP TABLE \`${db.name}\`.\`${t.name}\``,
                                  ).then(() => refreshDatabase(db.name));
                                }
                              },
                            },
                          ]);
                        }}
                        className="flex flex-1 items-center gap-1 px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                      >
                        <Table2 className="h-3 w-3 shrink-0" />
                        <span className="truncate">{t.name}</span>
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
                        title="View Structure"
                        className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 hover:bg-[var(--color-bg-primary)] hover:text-brand-400 group-hover/table:opacity-100"
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
                      onClick={handleViewClick(db.name, v.name)}
                      onContextMenu={(e) => {
                        showContextMenu(e, [
                          {
                            label: "Select Top 100 Rows",
                            icon: <Search className="h-3.5 w-3.5" />,
                            onClick: () => {
                              executeQuery(
                                connectionId,
                                `SELECT * FROM \`${db.name}\`.\`${v.name}\` LIMIT ${maxResultRows}`,
                                db.name,
                              );
                            },
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
                              openDdlTab(db.name, v.name, `SHOW CREATE VIEW \`${db.name}\`.\`${v.name}\``);
                            },
                          },
                          { separator: true },
                          {
                            label: "Drop View",
                            icon: <Trash2 className="h-3.5 w-3.5" />,
                            danger: true,
                            onClick: () => {
                              if (window.confirm(`Are you sure you want to drop view \`${db.name}\`.\`${v.name}\`?`)) {
                                executeQuery(connectionId, `DROP VIEW \`${db.name}\`.\`${v.name}\``).then(() =>
                                  refreshFolder(db.name, "views")
                                );
                              }
                            },
                          },
                        ]);
                      }}
                      className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
                    >
                      <Eye className="h-3 w-3 shrink-0" />
                      <span className="truncate">{v.name}</span>
                    </button>
                  ))}
                </FolderNode>
              )}

              {/* Procedures folder */}
              {isFolderVisible(filteredProcedures(db.name).length) && (
                <FolderNode
                  label="Procedures"
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
                              openDdlTab(db.name, r.name, `SHOW CREATE PROCEDURE \`${db.name}\`.\`${r.name}\``);
                            },
                          },
                          { separator: true },
                          {
                            label: "Drop Procedure",
                            icon: <Trash2 className="h-3.5 w-3.5" />,
                            danger: true,
                            onClick: () => {
                              if (
                                window.confirm(`Are you sure you want to drop procedure \`${db.name}\`.\`${r.name}\`?`)
                              ) {
                                executeQuery(connectionId, `DROP PROCEDURE \`${db.name}\`.\`${r.name}\``).then(() =>
                                  refreshFolder(db.name, "routines")
                                );
                              }
                            },
                          },
                        ]);
                      }}
                      className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
                    >
                      <Cog className="h-3 w-3 shrink-0" />
                      <span className="truncate">{r.name}</span>
                    </button>
                  ))}
                </FolderNode>
              )}

              {/* Functions folder */}
              {isFolderVisible(filteredFunctions(db.name).length) && (
                <FolderNode
                  label="Functions"
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
                              openDdlTab(db.name, r.name, `SHOW CREATE FUNCTION \`${db.name}\`.\`${r.name}\``);
                            },
                          },
                          { separator: true },
                          {
                            label: "Drop Function",
                            icon: <Trash2 className="h-3.5 w-3.5" />,
                            danger: true,
                            onClick: () => {
                              if (
                                window.confirm(`Are you sure you want to drop function \`${db.name}\`.\`${r.name}\`?`)
                              ) {
                                executeQuery(connectionId, `DROP FUNCTION \`${db.name}\`.\`${r.name}\``).then(() =>
                                  refreshFolder(db.name, "routines")
                                );
                              }
                            },
                          },
                        ]);
                      }}
                      className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
                    >
                      <FunctionSquare className="h-3 w-3 shrink-0" />
                      <span className="truncate">{r.name}</span>
                    </button>
                  ))}
                </FolderNode>
              )}

              {/* Triggers folder */}
              {isFolderVisible(filteredTriggers(db.name).length) && (
                <FolderNode
                  label="Triggers"
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
                      onClick={() => openDdlTab(db.name, t.name, `SHOW CREATE TRIGGER \`${db.name}\`.\`${t.name}\``)}
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
                              openDdlTab(db.name, t.name, `SHOW CREATE TRIGGER \`${db.name}\`.\`${t.name}\``);
                            },
                          },
                          { separator: true },
                          {
                            label: "Drop Trigger",
                            icon: <Trash2 className="h-3.5 w-3.5" />,
                            danger: true,
                            onClick: () => {
                              if (
                                window.confirm(`Are you sure you want to drop trigger \`${db.name}\`.\`${t.name}\`?`)
                              ) {
                                executeQuery(connectionId, `DROP TRIGGER \`${db.name}\`.\`${t.name}\``).then(() =>
                                  refreshFolder(db.name, "triggers")
                                );
                              }
                            },
                          },
                        ]);
                      }}
                      className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
                    >
                      <Zap className="h-3 w-3 shrink-0" />
                      <span className="truncate">{t.name}</span>
                      <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                        {t.timing} {t.event}
                      </span>
                    </button>
                  ))}
                </FolderNode>
              )}
            </div>
          )}
        </div>
      ))}
      {contextMenu}
    </div>
  );
}
