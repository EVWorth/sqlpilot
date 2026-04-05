import { useState, useEffect } from "react";
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
  Columns3,
  History,
  Cog,
  FunctionSquare,
  Zap,
  Star,
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
  const addTab = useEditorStore((s) => s.addTab);
  const addStructureTab = useEditorStore((s) => s.addStructureTab);
  const updateTabContent = useEditorStore((s) => s.updateTabContent);
  const executeQuery = useResultStore((s) => s.executeQuery);
  const { contextMenu, showContextMenu } = useContextMenu();

  useEffect(() => {
    api.getDatabases(connectionId).then(setDatabases).catch(console.error);
  }, [connectionId]);

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

  const openTableQuery = (dbName: string, tableName: string) => {
    const tabId = addTab(connectionId, dbName);
    updateTabContent(
      tabId,
      `SELECT * FROM \`${dbName}\`.\`${tableName}\` LIMIT 100;`,
    );
  };

  const openViewQuery = (dbName: string, viewName: string) => {
    const tabId = addTab(connectionId, dbName);
    updateTabContent(
      tabId,
      `SELECT * FROM \`${dbName}\`.\`${viewName}\` LIMIT 100;`,
    );
  };

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

  return (
    <div className="ml-4 border-l border-[var(--color-border)] pl-1">
      {databases.map((db) => (
        <div key={db.name}>
          <button
            onClick={() => toggleDb(db.name)}
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
              ]);
            }}
            className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          >
            {expanded[db.name] ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <Database className="h-3 w-3" />
            <span>{db.name}</span>
          </button>
          {expanded[db.name] && (
            <div className="ml-3">
              {/* Tables folder */}
              <FolderNode
                label="Tables"
                icon={<Table2 className="h-3 w-3" />}
                isExpanded={isFolderExpanded(db.name, "tables")}
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
                {tables[db.name]?.filter((t) => t.table_type !== "VIEW").map((t) => (
                  <div
                    key={t.name}
                    className="group/table flex items-center rounded hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <button
                      onClick={() => openTableQuery(db.name, t.name)}
                      onContextMenu={(e) => {
                        showContextMenu(e, [
                          {
                            label: "Select Top 100 Rows",
                            icon: <Search className="h-3.5 w-3.5" />,
                            onClick: () => {
                              const sql = `SELECT * FROM \`${db.name}\`.\`${t.name}\` LIMIT 100`;
                              const tabId = addTab(connectionId, db.name);
                              updateTabContent(tabId, sql);
                              executeQuery(connectionId, sql);
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

              {/* Views folder */}
              <FolderNode
                label="Views"
                icon={<Eye className="h-3 w-3" />}
                isExpanded={isFolderExpanded(db.name, "views")}
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
                {views[db.name]?.map((v) => (
                  <button
                    key={v.name}
                    onClick={() => openViewQuery(db.name, v.name)}
                    onContextMenu={(e) => {
                      showContextMenu(e, [
                        {
                          label: "Select Top 100 Rows",
                          icon: <Search className="h-3.5 w-3.5" />,
                          onClick: () => {
                            const sql = `SELECT * FROM \`${db.name}\`.\`${v.name}\` LIMIT 100`;
                            const tabId = addTab(connectionId, db.name);
                            updateTabContent(tabId, sql);
                            executeQuery(connectionId, sql);
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

              {/* Procedures folder */}
              <FolderNode
                label="Procedures"
                icon={<Cog className="h-3 w-3" />}
                isExpanded={isFolderExpanded(db.name, "procedures")}
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
                {routines[db.name]
                  ?.filter((r) => r.routine_type === "PROCEDURE")
                  .map((r) => (
                    <button
                      key={r.name}
                      onClick={() =>
                        openDdlTab(db.name, r.name, `SHOW CREATE PROCEDURE \`${db.name}\`.\`${r.name}\``)
                      }
                      onContextMenu={(e) => {
                        showContextMenu(e, [
                          {
                            label: "Copy Name",
                            icon: <Copy className="h-3.5 w-3.5" />,
                            onClick: () => {
                              navigator.clipboard.writeText(r.name);
                            },
                          },
                          {
                            label: "Show DDL",
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

              {/* Functions folder */}
              <FolderNode
                label="Functions"
                icon={<FunctionSquare className="h-3 w-3" />}
                isExpanded={isFolderExpanded(db.name, "functions")}
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
                {routines[db.name]
                  ?.filter((r) => r.routine_type === "FUNCTION")
                  .map((r) => (
                    <button
                      key={r.name}
                      onClick={() =>
                        openDdlTab(db.name, r.name, `SHOW CREATE FUNCTION \`${db.name}\`.\`${r.name}\``)
                      }
                      onContextMenu={(e) => {
                        showContextMenu(e, [
                          {
                            label: "Copy Name",
                            icon: <Copy className="h-3.5 w-3.5" />,
                            onClick: () => {
                              navigator.clipboard.writeText(r.name);
                            },
                          },
                          {
                            label: "Show DDL",
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

              {/* Triggers folder */}
              <FolderNode
                label="Triggers"
                icon={<Zap className="h-3 w-3" />}
                isExpanded={isFolderExpanded(db.name, "triggers")}
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
                {triggers[db.name]?.map((t) => (
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
