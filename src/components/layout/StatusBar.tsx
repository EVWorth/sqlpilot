import { useConnectionStore } from "../../stores/connectionStore";
import { useResultStore } from "../../stores/resultStore";
import { Loader2 } from "lucide-react";

export function StatusBar() {
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const isExecuting = useResultStore((s) => s.isExecuting);
  const results = useResultStore((s) => s.results);
  const activeResultIndex = useResultStore((s) => s.activeResultIndex);

  const activeConn = activeConnections.find(
    (c) => c.id === selectedConnectionId,
  );
  const activeResult = results[activeResultIndex];

  return (
    <div className="flex h-6 items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3">
      <div className="flex items-center gap-3">
        {activeConn ? (
          <>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              <span className="text-[10px] text-[var(--color-text-secondary)]">
                {activeConn.name} — {activeConn.host}:{activeConn.port}
              </span>
            </div>
            {activeConn.database && (
              <span className="text-[10px] text-[var(--color-text-muted)]">
                {activeConn.database}
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
        {isExecuting && (
          <div className="flex items-center gap-1 text-[10px] text-brand-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Executing...
          </div>
        )}
        {activeResult && !isExecuting && (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {activeResult.rows.length} rows · {activeResult.execution_time_ms}ms
          </span>
        )}
        <span className="text-[10px] text-[var(--color-text-muted)]">
          MySQL AI Studio v0.1.0
        </span>
      </div>
    </div>
  );
}
