import { AlertTriangle, CheckCircle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  CONNECTED_REPLICAS,
  type ConnectedReplica,
  describeReplicaHealth,
  parseConnectedReplicas,
  parsePrimaryStatus,
  parseReplicaStatus,
  PRIMARY_STATUS,
  type PrimaryStatus,
  REPLICA_STATUS,
  type ReplicaStatus,
  type StatementWithFallback,
} from "../../lib/admin/replication";
import { runStatement } from "../../lib/run-statement";
import type { QueryResult } from "../../types";

/**
 * Replication, from whichever side of it this server is on.
 *
 * FR-7.2.4 asked for replication monitoring and there was none (#434).
 *
 * A server can be a replica, a primary, both, or neither, and the panel shows
 * whichever apply rather than asking the user which they expected. "Neither"
 * is a normal answer for a standalone server, not an error.
 */

/** Run the modern statement, falling back to the older name on a syntax error. */
async function runWithFallback(
  connectionId: string,
  statement: StatementWithFallback,
): Promise<QueryResult | null> {
  for (const sql of [statement.preferred, statement.fallback]) {
    try {
      const results = await runStatement({ connectionId, sql, origin: "internal" });
      return results[0] ?? null;
    } catch {
      // Only the fallback's failure is worth reporting: the first is expected
      // on any server that predates the rename, or postdates the removal.
    }
  }
  return null;
}

export function ReplicationTab({ connectionId }: { connectionId: string }) {
  const [replica, setReplica] = useState<ReplicaStatus | null>(null);
  const [primary, setPrimary] = useState<PrimaryStatus | null>(null);
  const [replicas, setReplicas] = useState<ConnectedReplica[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [replicaResult, primaryResult, replicasResult] = await Promise.all([
        runWithFallback(connectionId, REPLICA_STATUS),
        runWithFallback(connectionId, PRIMARY_STATUS),
        runWithFallback(connectionId, CONNECTED_REPLICAS),
      ]);

      setReplica(
        replicaResult
          ? parseReplicaStatus(
            replicaResult.columns.map((c) => c.name),
            replicaResult.rows[0],
          )
          : null,
      );
      setPrimary(
        primaryResult
          ? parsePrimaryStatus(
            primaryResult.columns.map((c) => c.name),
            primaryResult.rows[0],
          )
          : null,
      );
      setReplicas(
        replicasResult
          ? parseConnectedReplicas(
            replicasResult.columns.map((c) => c.name),
            replicasResult.rows,
          )
          : [],
      );
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-[var(--color-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading replication status…
      </div>
    );
  }

  const health = replica ? describeReplicaHealth(replica) : null;
  const standalone = !replica && !primary && replicas.length === 0;
  const cell = "py-1 pr-4 text-[var(--color-text-muted)]";
  const value = "py-1 font-mono text-[var(--color-text-primary)]";

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-medium text-[var(--color-text-primary)]">Replication</h3>
        <button
          onClick={() => void load()}
          title="Refresh"
          className="ml-auto rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && <p role="alert" className="mb-2 text-[11px] text-red-400">{error}</p>}

      {standalone && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          This server is neither a replica nor a primary with binary logging on. That is the normal state for a
          standalone server.
        </p>
      )}

      {replica && health && (
        <section className="mb-4">
          <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
            {health.healthy
              ? <CheckCircle className="h-3.5 w-3.5 text-green-400" />
              : <AlertTriangle className="h-3.5 w-3.5 text-red-400" />}
            Replicating from {replica.sourceHost}:{replica.sourcePort}
          </h4>
          <p
            className={`mb-2 text-[11px] ${health.healthy ? "text-green-400" : "text-red-400"}`}
            role={health.healthy ? undefined : "alert"}
          >
            {health.summary}
          </p>
          <table className="text-[11px]">
            <tbody>
              <tr>
                <td className={cell}>IO thread</td>
                <td className={value}>{replica.ioRunning ? "Running" : "Stopped"}</td>
              </tr>
              <tr>
                <td className={cell}>SQL thread</td>
                <td className={value}>{replica.sqlRunning ? "Running" : "Stopped"}</td>
              </tr>
              <tr>
                <td className={cell}>Behind source</td>
                <td className={value}>
                  {replica.secondsBehind === null ? "unknown" : `${replica.secondsBehind}s`}
                </td>
              </tr>
              <tr>
                <td className={cell}>Reading</td>
                <td className={value}>{replica.sourceLogFile}:{replica.readLogPos}</td>
              </tr>
              {replica.state && (
                <tr>
                  <td className={cell}>State</td>
                  <td className={value}>{replica.state}</td>
                </tr>
              )}
              {replica.lastIoError && (
                <tr>
                  <td className={cell}>Last IO error</td>
                  <td className="py-1 font-mono text-red-400">{replica.lastIoError}</td>
                </tr>
              )}
              {replica.lastSqlError && (
                <tr>
                  <td className={cell}>Last SQL error</td>
                  <td className="py-1 font-mono text-red-400">{replica.lastSqlError}</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {primary && (
        <section className="mb-4">
          <h4 className="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
            Binary log
          </h4>
          <table className="text-[11px]">
            <tbody>
              <tr>
                <td className={cell}>Position</td>
                <td className={value}>{primary.file}:{primary.position}</td>
              </tr>
              {primary.executedGtidSet && (
                <tr>
                  <td className={cell}>Executed GTIDs</td>
                  <td className="max-w-[520px] break-all py-1 font-mono text-[var(--color-text-primary)]">
                    {primary.executedGtidSet}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {replicas.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
            Connected replicas
          </h4>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-secondary)]">
                <th className="py-1 pr-4 font-medium">Server ID</th>
                <th className="py-1 pr-4 font-medium">Host</th>
                <th className="py-1 font-medium">Port</th>
              </tr>
            </thead>
            <tbody>
              {replicas.map((r) => (
                <tr key={r.serverId} className="border-b border-[var(--color-border)]">
                  <td className="py-1 pr-4 font-mono">{r.serverId}</td>
                  {
                    /* SHOW REPLICAS reports an empty host unless the replica was
                      started with report_host, which most are not. */
                  }
                  <td className="py-1 pr-4 font-mono">{r.host || "not reported"}</td>
                  <td className="py-1 font-mono">{r.port}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
