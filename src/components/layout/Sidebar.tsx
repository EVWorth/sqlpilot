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
} from "lucide-react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { ConnectionDialog } from "../connection/ConnectionDialog";
import { cn } from "../../lib/utils";
import { api } from "../../lib/tauri-api";
import type { DatabaseInfo, TableInfo } from "../../types";

export function Sidebar() {
  const [showDialog, setShowDialog] = useState(false);
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

      <ConnectionDialog
        isOpen={showDialog}
        onClose={() => setShowDialog(false)}
      />
    </div>
  );
}

function SchemaTree({ connectionId }: { connectionId: string }) {
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const addTab = useEditorStore((s) => s.addTab);
  const updateTabContent = useEditorStore((s) => s.updateTabContent);

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

  return (
    <div className="ml-4 border-l border-[var(--color-border)] pl-1">
      {databases.map((db) => (
        <div key={db.name}>
          <button
            onClick={() => toggleDb(db.name)}
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
                <button
                  key={t.name}
                  onClick={() => openTableQuery(db.name, t.name)}
                  className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
                >
                  {t.table_type === "VIEW" ? (
                    <Eye className="h-3 w-3" />
                  ) : (
                    <Table2 className="h-3 w-3" />
                  )}
                  <span>{t.name}</span>
                  {t.row_count != null && (
                    <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                      ~{t.row_count.toLocaleString()}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
