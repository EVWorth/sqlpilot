import { useState } from "react";
import {
  Database,
  ChevronRight,
  ChevronDown,
  History,
  Star,
} from "lucide-react";
import { useConnectionStore } from "../../stores/connectionStore";
import { QueryHistory } from "../history/QueryHistory";
import { QueryFavorites } from "../favorites/QueryFavorites";
import { SchemaTree } from "../schema/SchemaTree";

export function Sidebar() {
  const [showHistory, setShowHistory] = useState(false);
  const [showFavorites, setShowFavorites] = useState(false);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );

  const selectedConnection = activeConnections.find(
    (c) => c.id === selectedConnectionId,
  );
  const selectedProfile = selectedConnection
    ? profiles.find((p) => p.id === selectedConnection.profile_id)
    : undefined;

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-secondary)]">
      {selectedConnection && (
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-1.5 shrink-0">
          <Database className="h-3 w-3 shrink-0 text-green-400" />
          {selectedProfile?.color && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: selectedProfile.color }}
            />
          )}
          <span className="truncate text-[11px] font-medium text-[var(--color-text-secondary)]">
            {selectedProfile?.username
              ? `${selectedProfile.username}@${selectedConnection.host}`
              : selectedConnection.host}
            {selectedConnection.port !== 3306 ? `:${selectedConnection.port}` : ""}
          </span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {selectedConnection ? (
          <SchemaTree connectionId={selectedConnection.id} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
            <Database className="h-8 w-8 text-[var(--color-text-muted)] opacity-40" />
            <p className="text-xs text-[var(--color-text-muted)]">
              No connection selected
            </p>
          </div>
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
    </div>
  );
}
