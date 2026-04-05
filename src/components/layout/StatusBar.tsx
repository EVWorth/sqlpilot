import { useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useResultStore } from "../../stores/resultStore";
import { useEditorStore } from "../../stores/editorStore";
import { Loader2, AlertCircle, AlertTriangle, Copy, Check } from "lucide-react";
import type { ConnectionEnvironment } from "../../types";

const ENV_BADGES: Record<ConnectionEnvironment, { label: string; className: string }> = {
  production: { label: "PROD", className: "bg-red-500/20 text-red-400" },
  staging: { label: "STG", className: "bg-yellow-500/20 text-yellow-400" },
  development: { label: "DEV", className: "bg-green-500/20 text-green-400" },
};

function formatTime(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRows(count: number): string {
  return count.toLocaleString() + " row" + (count === 1 ? "" : "s");
}

export function StatusBar() {
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const isExecuting = useResultStore((s) => s.isExecuting);
  const results = useResultStore((s) => s.results);
  const activeResultIndex = useResultStore((s) => s.activeResultIndex);
  const error = useResultStore((s) => s.error);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);

  const [showFullError, setShowFullError] = useState(false);
  const [copied, setCopied] = useState(false);

  const activeConn = activeConnections.find(
    (c) => c.id === selectedConnectionId,
  );
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfile = activeConn
    ? profiles.find((p) => p.id === activeConn.profile_id)
    : undefined;
  const envBadge = activeProfile?.environment
    ? ENV_BADGES[activeProfile.environment]
    : undefined;
  const activeResult = results[activeResultIndex];
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const selectedDatabase = activeTab?.database ?? activeConn?.database;
  const warningsCount = activeResult?.warnings?.length ?? 0;

  const handleCopyConnection = () => {
    if (!activeConn) return;
    const connStr = `mysql://${activeConn.host}:${activeConn.port}${activeConn.database ? "/" + activeConn.database : ""}`;
    navigator.clipboard.writeText(connStr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex h-6 items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3">
      <div className="flex items-center gap-3">
        {activeConn ? (
          <>
            <button
              onClick={handleCopyConnection}
              className="flex items-center gap-1.5 hover:text-[var(--color-text-primary)] transition-colors"
              title="Click to copy connection string"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              <span className="text-[10px] text-[var(--color-text-secondary)]">
                {activeConn.name} — {activeConn.host}:{activeConn.port}
              </span>
              {copied ? (
                <Check className="h-2.5 w-2.5 text-green-400" />
              ) : (
                <Copy className="h-2.5 w-2.5 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100" />
              )}
            </button>
            {selectedDatabase && (
              <span className="text-[10px] text-brand-400 font-medium">
                {selectedDatabase}
              </span>
            )}
            <span className="text-[10px] text-[var(--color-text-muted)]">
              MySQL {activeConn.server_version}
            </span>
          </>
        ) : (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            Disconnected
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {error && !isExecuting && (
          <button
            onClick={() => setShowFullError(!showFullError)}
            className="flex items-center gap-1 text-[10px] text-red-400 max-w-[300px] hover:text-red-300 transition-colors"
            title={showFullError ? error : "Click to expand error"}
          >
            <AlertCircle className="h-3 w-3 flex-shrink-0" />
            <span className={showFullError ? "" : "truncate"}>
              {error}
            </span>
          </button>
        )}
        {warningsCount > 0 && !isExecuting && (
          <div className="flex items-center gap-1 text-[10px] text-yellow-400">
            <AlertTriangle className="h-3 w-3" />
            {warningsCount} warning{warningsCount !== 1 ? "s" : ""}
          </div>
        )}
        {isExecuting && (
          <div className="flex items-center gap-1 text-[10px] text-brand-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Executing...
          </div>
        )}
        {activeResult && !isExecuting && (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {formatRows(activeResult.rows.length)} · {formatTime(activeResult.execution_time_ms)}
          </span>
        )}
        <span className="text-[10px] text-[var(--color-text-muted)]">
          MySQL AI Studio v0.1.0
        </span>
      </div>
    </div>
  );
}
