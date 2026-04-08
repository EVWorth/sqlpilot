import { useState, useEffect, useRef } from "react";
import {
  Plus,
  Database,
  Plug,
  Unplug,
  Trash2,
  ChevronRight,
  ChevronDown,
  Table2,
  Eye,
  FileText,
  RefreshCw,
  Copy,
  Search,
  X,
  Columns3,
  History,
  Cog,
  FunctionSquare,
  Zap,
  Star,
  Play,
  HardDriveDownload,
  HardDriveUpload,
  PenLine,
} from "lucide-react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { ConnectionDialog } from "../connection/ConnectionDialog";
import { QueryHistory } from "../history/QueryHistory";
import { QueryFavorites } from "../favorites/QueryFavorites";
import { cn } from "../../lib/utils";
import { api } from "../../lib/tauri-api";
import { useContextMenu } from "../../hooks/useContextMenu";
import { useClickHandler } from "../../hooks/useClickHandler";
import type { DatabaseInfo, TableInfo, ViewInfo, RoutineInfo, TriggerInfo } from "../../types";

export function Sidebar() {
  const [showDialog, setShowDialog] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showFavorites, setShowFavorites] = useState(false);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const connect = useConnectionStore((s) => s.connect);
  const disconnect = useConnectionStore((s) => s.disconnect);
  const deleteProfile = useConnectionStore((s) => s.deleteProfile);
  const loadProfiles = useConnectionStore((s) => s.loadProfiles);
  const setSelectedConnection = useConnectionStore(
    (s) => s.setSelectedConnection,
  );
  const addTab = useEditorStore((s) => s.addTab);
  const { contextMenu, showContextMenu } = useContextMenu();

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const getActiveConnection = (profileId: string) =>
    activeConnections.find((c) => c.profile_id === profileId);

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-secondary)]">
      <div className="flex h-9 items-center justify-between border-b border-[var(--color-border)] px-3">
        <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
          Connections
        </span>
        <button
          onClick={() => setShowDialog(true)}
          className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-1">
        {profiles.length === 0 ? (
          <p className="p-3 text-xs text-[var(--color-text-muted)]">
            No connections yet.
          </p>
        ) : (
          profiles.map((profile) => {
            const conn = getActiveConnection(profile.id);
            const isConnected = !!conn;
            const isSelected = conn && conn.id === selectedConnectionId;

            return (
              <div key={profile.id} className="mb-0.5">
                <div
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs",
                    isSelected
                      ? "bg-brand-600/20 text-brand-300"
                      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]",
                  )}
                  onClick={() => {
                    if (conn) setSelectedConnection(conn.id);
                  }}
                  onContextMenu={(e) => {
                    showContextMenu(e, [
                      {
                        label: "New Query",
                        icon: <FileText className="h-3.5 w-3.5" />,
                        onClick: () => addTab(conn?.id),
                      },
                      {
                        label: "Disconnect",
                        icon: <Unplug className="h-3.5 w-3.5" />,
                        onClick: () => {
                          if (conn) disconnect(conn.id);
                        },
                        disabled: !isConnected,
                      },
                      { label: "", separator: true, onClick: () => {} },
                      {
                        label: "Delete Connection",
                        icon: <Trash2 className="h-3.5 w-3.5" />,
                        onClick: () => deleteProfile(profile.id),
                        danger: true,
                      },
                    ]);
                  }}
                >
                  <Database
                    className={cn(
                      "h-3.5 w-3.5",
                      isConnected
                        ? "text-green-400"
                        : "text-[var(--color-text-muted)]",
                    )}
                  />
                  {profile.color && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: profile.color }}
                    />
                  )}
                  <span className="flex-1 truncate">
                    {profile.name || profile.host}
                  </span>
                  <div className="flex items-center gap-0.5">
                    {!isConnected ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          connect(profile.id);
                        }}
                        className="rounded p-0.5 hover:bg-[var(--color-bg-primary)]"
                        title="Connect"
                      >
                        <Plug className="h-3 w-3" />
                      </button>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          disconnect(conn!.id);
                        }}
                        className="rounded p-0.5 hover:bg-[var(--color-bg-primary)]"
                        title="Disconnect"
                      >
                        <Unplug className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteProfile(profile.id);
                      }}
                      className="rounded p-0.5 text-red-400 opacity-0 hover:bg-[var(--color-bg-primary)] group-hover:opacity-100"
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                {isConnected && conn && (
                  <SchemaTree connectionId={conn.id} />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Favorites panel */}
      <div className="border-t border-[var(--color-border)]">
        <button
          onClick={() => setShowFavorites(!showFavorites)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
        >
          <Star className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">Favorites</span>
          {showFavorites ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        {showFavorites && (
          <div className="h-64 overflow-hidden">
            <QueryFavorites />
          </div>
        )}
      </div>

      {/* History panel */}
      <div className="border-t border-[var(--color-border)]">
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
        >
          <History className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">History</span>
          {showHistory ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        {showHistory && (
          <div className="h-64 overflow-hidden">
            <QueryHistory />
          </div>
        )}
      </div>

      <ConnectionDialog
        isOpen={showDialog}
        onClose={() => setShowDialog(false)}
      />
      {contextMenu}
    </div>
  );
}

function SchemaTree({ connectionId }: { connectionId: string }) {
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [views, setViews] = useState<Record<string, ViewInfo[]>>({});
  const [routines, setRoutines] = useState<Record<string, RoutineInfo[]>>({});
  const [triggers, setTriggers] = useState<Record<string, TriggerInfo[]>>({});
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

  // Derive the selected database from the active tab
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const selectedDb = activeTab?.database ?? null;

  // Set the active tab's database context to the given DB
  const selectDatabase = (dbName: string) => {
    if (!activeTabId) return;
    setTabConnection(activeTabId, connectionId, dbName);
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
    api.getDatabases(connectionId).then(setDatabases).catch(console.error);
  }, [connectionId]);

  // Ctrl+Shift+F focuses the filter input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // When filter becomes active, eagerly fetch all unloaded DB data so search is complete
  const filterActive = filterText.trim().length > 0;
  useEffect(() => {
    if (!filterActive || databases.length === 0) return;
    databases.forEach(async (db) => {
      try {
        if (!tables[db.name]) {
          const t = await api.getTables(connectionId, db.name);
          setTables((prev) => ({ ...prev, [db.name]: t }));
        }
        if (!views[db.name]) {
          const v = await api.getViews(connectionId, db.name);
          setViews((prev) => ({ ...prev, [db.name]: v }));
        }
        if (!routines[db.name]) {
          const r = await api.getRoutines(connectionId, db.name);
          setRoutines((prev) => ({ ...prev, [db.name]: r }));
        }
        if (!triggers[db.name]) {
          const t = await api.getTriggers(connectionId, db.name);
          setTriggers((prev) => ({ ...prev, [db.name]: t }));
        }
      } catch (e) {
        console.error(e);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterActive, databases]);

  const toggleDb = async (dbName: string) => {
    const isExpanded = expanded[dbName];
    setExpanded((prev) => ({ ...prev, [dbName]: !isExpanded }));
    if (!isExpanded && !tables[dbName]) {
      try {
        const t = await api.getTables(connectionId, dbName);
        setTables((prev) => ({ ...prev, [dbName]: t }));
      } catch (e) {
        console.error(e);
      }
    }
  };

  const folderKey = (dbName: string, folder: string) => `${dbName}:${folder}`;

  const toggleFolder = async (dbName: string, folder: string) => {
    const key = folderKey(dbName, folder);
    const isExpanded = expandedFolders[key];
    setExpandedFolders((prev) => ({ ...prev, [key]: !isExpanded }));
    if (!isExpanded) {
      try {
        if (folder === "views" && !views[dbName]) {
          const v = await api.getViews(connectionId, dbName);
          setViews((prev) => ({ ...prev, [dbName]: v }));
        } else if ((folder === "procedures" || folder === "functions") && !routines[dbName]) {
          const r = await api.getRoutines(connectionId, dbName);
          setRoutines((prev) => ({ ...prev, [dbName]: r }));
        } else if (folder === "triggers" && !triggers[dbName]) {
          const t = await api.getTriggers(connectionId, dbName);
          setTriggers((prev) => ({ ...prev, [dbName]: t }));
        }
      } catch (e) {
        console.error(e);
      }
    }
  };

  // Single click: run SELECT inline without touching the editor tab
  // Double click (within 250ms): insert table name at cursor instead
  const handleTableClick = (dbName: string, tableName: string) =>
    makeClickHandler(
      `${dbName}.${tableName}`,
      () => executeQuery(connectionId, `SELECT * FROM \`${dbName}\`.\`${tableName}\` LIMIT 100`, dbName),
      () => insertNameAtCursor(tableName),
    );

  const handleViewClick = (dbName: string, viewName: string) =>
    makeClickHandler(
      `${dbName}.${viewName}`,
      () => executeQuery(connectionId, `SELECT * FROM \`${dbName}\`.\`${viewName}\` LIMIT 100`, dbName),
      () => insertNameAtCursor(viewName),
    );

  const openDdlTab = (dbName: string, _objectName: string, ddlQuery: string) => {
    const tabId = addTab(connectionId, dbName);
    updateTabContent(tabId, ddlQuery);
    executeQuery(connectionId, ddlQuery);
  };

  const refreshTables = async (dbName: string) => {
    try {
      const t = await api.getTables(connectionId, dbName);
      setTables((prev) => ({ ...prev, [dbName]: t }));
    } catch (e) {
      console.error(e);
    }
  };

  const refreshFolder = async (dbName: string, folder: string) => {
    try {
      if (folder === "views") {
        const v = await api.getViews(connectionId, dbName);
        setViews((prev) => ({ ...prev, [dbName]: v }));
      } else if (folder === "routines") {
        const r = await api.getRoutines(connectionId, dbName);
        setRoutines((prev) => ({ ...prev, [dbName]: r }));
      } else if (folder === "triggers") {
        const t = await api.getTriggers(connectionId, dbName);
        setTriggers((prev) => ({ ...prev, [dbName]: t }));
      }
    } catch (e) {
      console.error(e);
    }
  };

  const isFolderExpanded = (dbName: string, folder: string) =>
    !!expandedFolders[folderKey(dbName, folder)];

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
    filteredTables(dbName).length > 0 ||
    filteredViews(dbName).length > 0 ||
    filteredProcedures(dbName).length > 0 ||
    filteredFunctions(dbName).length > 0 ||
    filteredTriggers(dbName).length > 0;

  // Show all DBs while filtering; hide only those whose data IS loaded and has no matches
  const isDbVisible = (dbName: string) =>
    !isFiltering || tables[dbName] === undefined || dbHasMatches(dbName);

  // Auto-expand when matches found; also respect manual toggles while filtering
  const isDbExpanded = (dbName: string) =>
    isFiltering
      ? !!expanded[dbName] || (tables[dbName] !== undefined && dbHasMatches(dbName))
      : !!expanded[dbName];

  // When filtering, hide empty folders and auto-expand folders with matches;
  // also respect manual folder toggles
  const isFolderVisible = (count: number) =>
    !isFiltering || count > 0;
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
                  onClick: () => refreshTables(db.name),
                },
                { label: "", separator: true, onClick: () => {} },
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
            {isDbExpanded(db.name) ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <Database className={cn("h-3 w-3", selectedDb === db.name && "text-[var(--color-accent)]")} />
            <span>{db.name}</span>
            {selectedDb === db.name && (
              <span className="ml-auto text-[9px] text-[var(--color-accent)] opacity-75">●</span>
            )}
          </button>
          {isDbExpanded(db.name) && (
            <div className="ml-3">
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
                      onClick: () => refreshTables(db.name),
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
                              executeQuery(connectionId, `SELECT * FROM \`${db.name}\`.\`${t.name}\` LIMIT 100`, db.name);
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
                          { label: "", separator: true, onClick: () => {} },
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
                                ).then(() => refreshTables(db.name));
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
                            executeQuery(connectionId, `SELECT * FROM \`${db.name}\`.\`${v.name}\` LIMIT 100`, db.name);
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
                        { label: "", separator: true, onClick: () => {} },
                        {
                          label: "Drop View",
                          icon: <Trash2 className="h-3.5 w-3.5" />,
                          danger: true,
                          onClick: () => {
                            if (window.confirm(`Are you sure you want to drop view \`${db.name}\`.\`${v.name}\`?`)) {
                              executeQuery(connectionId, `DROP VIEW \`${db.name}\`.\`${v.name}\``).then(() =>
                                refreshFolder(db.name, "views"),
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
                      onClick={() =>
                        addRoutineTab(connectionId, db.name, r.name, "PROCEDURE")
                      }
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
                          { label: "", separator: true, onClick: () => {} },
                          {
                            label: "Drop Procedure",
                            icon: <Trash2 className="h-3.5 w-3.5" />,
                            danger: true,
                            onClick: () => {
                              if (
                                window.confirm(`Are you sure you want to drop procedure \`${db.name}\`.\`${r.name}\`?`)
                              ) {
                                executeQuery(connectionId, `DROP PROCEDURE \`${db.name}\`.\`${r.name}\``).then(() =>
                                  refreshFolder(db.name, "routines"),
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
                      onClick={() =>
                        addRoutineTab(connectionId, db.name, r.name, "FUNCTION")
                      }
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
                          { label: "", separator: true, onClick: () => {} },
                          {
                            label: "Drop Function",
                            icon: <Trash2 className="h-3.5 w-3.5" />,
                            danger: true,
                            onClick: () => {
                              if (
                                window.confirm(`Are you sure you want to drop function \`${db.name}\`.\`${r.name}\`?`)
                              ) {
                                executeQuery(connectionId, `DROP FUNCTION \`${db.name}\`.\`${r.name}\``).then(() =>
                                  refreshFolder(db.name, "routines"),
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
                    onClick={() =>
                      openDdlTab(db.name, t.name, `SHOW CREATE TRIGGER \`${db.name}\`.\`${t.name}\``)
                    }
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
                        { label: "", separator: true, onClick: () => {} },
                        {
                          label: "Drop Trigger",
                          icon: <Trash2 className="h-3.5 w-3.5" />,
                          danger: true,
                          onClick: () => {
                            if (window.confirm(`Are you sure you want to drop trigger \`${db.name}\`.\`${t.name}\`?`)) {
                              executeQuery(connectionId, `DROP TRIGGER \`${db.name}\`.\`${t.name}\``).then(() =>
                                refreshFolder(db.name, "triggers"),
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

function FolderNode({
  label,
  icon,
  isExpanded,
  onToggle,
  onContextMenu,
  count,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  count?: number;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        onContextMenu={onContextMenu}
        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {icon}
        <span>{label}</span>
        {count != null && (
          <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
            {count}
          </span>
        )}
      </button>
      {isExpanded && <div className="ml-3">{children}</div>}
    </div>
  );
}
