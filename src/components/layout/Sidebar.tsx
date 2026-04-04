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
} from "lucide-react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { ConnectionDialog } from "../connection/ConnectionDialog";
import { QueryHistory } from "../history/QueryHistory";
import { cn } from "../../lib/utils";
import { api } from "../../lib/tauri-api";
import { useContextMenu } from "../../hooks/useContextMenu";
import type { DatabaseInfo, TableInfo } from "../../types";

export function Sidebar() {
  const [showDialog, setShowDialog] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
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
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
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

  const openTableQuery = (dbName: string, tableName: string) => {
    const tabId = addTab(connectionId, dbName);
    updateTabContent(
      tabId,
      `SELECT * FROM \`${dbName}\`.\`${tableName}\` LIMIT 100;`,
    );
  };

  const refreshTables = async (dbName: string) => {
    try {
      const t = await api.getTables(connectionId, dbName);
      setTables((prev) => ({ ...prev, [dbName]: t }));
    } catch (e) {
      console.error(e);
    }
  };

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
          {expanded[db.name] && tables[db.name] && (
            <div className="ml-3">
              {tables[db.name].map((t) => (
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
                        label: "Copy Table Name",
                        icon: <Copy className="h-3.5 w-3.5" />,
                        onClick: () => {
                          navigator.clipboard.writeText(t.name);
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
                  {t.table_type === "VIEW" ? (
                    <Eye className="h-3 w-3 shrink-0" />
                  ) : (
                    <Table2 className="h-3 w-3 shrink-0" />
                  )}
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
            </div>
          )}
        </div>
      ))}
      {contextMenu}
    </div>
  );
}
