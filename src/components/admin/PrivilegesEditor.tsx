import { Check, Database, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { runStatement } from "../../lib/run-statement";
import { quoteIdentifier, quoteStringLiteral } from "../../lib/sql-quote";
import { api } from "../../lib/tauri-api";
import { cn } from "../../lib/utils";
import { confirmDestructive } from "../../stores/productionGuardStore";
import { SQLPreviewDialog } from "../common/SQLPreviewDialog";
import { describePartialFailure, setsEqual } from "./grantReporting";
import { categorizeGrants, DATABASE_PRIVILEGES, GLOBAL_PRIVILEGES, parseGrantStatements } from "./userPrivileges";

interface DbPrivState {
  current: Set<string>;
  edited: Set<string>;
}

/** Shared empty set, so a database with nothing selected has a stable identity. */
const EMPTY_PRIVS: Set<string> = new Set();

export function PrivilegesEditor({
  connectionId,
  user,
  host,
}: {
  connectionId: string;
  user: string;
  host: string;
}) {
  const [currentGlobalPrivs, setCurrentGlobalPrivs] = useState<Set<string>>(
    new Set(),
  );
  const [editedGlobalPrivs, setEditedGlobalPrivs] = useState<Set<string>>(
    new Set(),
  );
  const [hasGrantOption, setHasGrantOption] = useState(false);
  const [editedGrantOption, setEditedGrantOption] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  // The batch waiting for approval. GRANT and REVOKE force an implicit
  // commit, so once Apply runs there is no way back — the preview is the last
  // point at which the whole change can still be reconsidered (#439).
  const [pendingStatements, setPendingStatements] = useState<string[] | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Database privileges
  const [databases, setDatabases] = useState<string[]>([]);
  const [selectedDb, setSelectedDb] = useState<string>("");
  // Keyed by database, so switching away and back does not throw away edits
  // that were never applied (#441). Holding a single pair of sets meant the
  // reload for the newly-selected database overwrote the previous one's
  // pending changes, silently.
  const [dbPrivs, setDbPrivs] = useState<Map<string, DbPrivState>>(new Map());
  const [dbLoading, setDbLoading] = useState(false);

  const selectedDbPrivs = selectedDb ? dbPrivs.get(selectedDb) : undefined;
  const currentDbPrivs = selectedDbPrivs?.current ?? EMPTY_PRIVS;
  const editedDbPrivs = selectedDbPrivs?.edited ?? EMPTY_PRIVS;

  /** Databases whose privileges have been edited but not applied. */
  const dirtyDbs = useMemo(
    () =>
      [...dbPrivs.entries()]
        .filter(([, state]) => !setsEqual(state.current, state.edited))
        .map(([db]) => db),
    [dbPrivs],
  );

  // Load grants
  const loadGrants = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await runStatement({
        connectionId,
        sql: `SHOW GRANTS FOR ${quoteStringLiteral(user)}@${quoteStringLiteral(host)}`,
        origin: "internal",
      });
      if (results.length > 0) {
        const rawGrants = results[0].rows.map((row) => String(row[0] ?? ""));
        const parsed = parseGrantStatements(rawGrants);
        const categorized = categorizeGrants(parsed);

        const globalPrivs = new Set<string>();
        let grantOpt = false;
        for (const g of categorized.global) {
          if (g.privileges.includes("ALL PRIVILEGES")) {
            GLOBAL_PRIVILEGES.forEach((p) => globalPrivs.add(p));
          } else {
            g.privileges.forEach((p) => globalPrivs.add(p.toUpperCase()));
          }
          if (g.grantOption) grantOpt = true;
        }
        setCurrentGlobalPrivs(new Set(globalPrivs));
        setEditedGlobalPrivs(new Set(globalPrivs));
        setHasGrantOption(grantOpt);
        setEditedGrantOption(grantOpt);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId, user, host]);

  // Load databases
  useEffect(() => {
    api
      .getDatabases(connectionId)
      .then((dbs) =>
        setDatabases(
          dbs
            .map((d) => d.name)
            .filter(
              (name) =>
                name !== "information_schema"
                && name !== "performance_schema"
                && name !== "sys",
            ),
        )
      )
      .catch((e) => console.error("Failed to load schemas", e));
  }, [connectionId]);

  useEffect(() => {
    loadGrants();
  }, [loadGrants]);

  // Load database-specific privileges
  useEffect(() => {
    if (!selectedDb) return;
    // Already held — including any unapplied edits — so leave it alone.
    if (dbPrivs.has(selectedDb)) return;
    setDbLoading(true);
    api
      .executeQuery(
        connectionId,
        `SHOW GRANTS FOR ${quoteStringLiteral(user)}@${quoteStringLiteral(host)}`,
      )
      .then((results) => {
        if (results.length > 0) {
          const rawGrants = results[0].rows.map((row) => String(row[0] ?? ""));
          const parsed = parseGrantStatements(rawGrants);
          const categorized = categorizeGrants(parsed);
          const dbGrant = categorized.database.get(selectedDb);
          const privs = new Set<string>();
          if (dbGrant) {
            if (dbGrant.privileges.includes("ALL PRIVILEGES")) {
              DATABASE_PRIVILEGES.forEach((p) => privs.add(p));
            } else {
              dbGrant.privileges.forEach((p) => privs.add(p.toUpperCase()));
            }
          }
          setDbPrivs((prev) => {
            // A concurrent load may have filled this in; never overwrite.
            if (prev.has(selectedDb)) return prev;
            const next = new Map(prev);
            next.set(selectedDb, { current: new Set(privs), edited: new Set(privs) });
            return next;
          });
        }
      })
      .catch((e) => setError(`Failed to load privileges for ${selectedDb}: ${e}`))
      .finally(() => setDbLoading(false));
  }, [connectionId, user, host, selectedDb, dbPrivs]);

  const toggleGlobalPriv = (priv: string) => {
    setEditedGlobalPrivs((prev) => {
      const next = new Set(prev);
      if (next.has(priv)) {
        next.delete(priv);
      } else {
        next.add(priv);
      }
      return next;
    });
    setSuccessMsg(null);
  };

  const toggleDbPriv = (priv: string) => {
    if (!selectedDb) return;
    setDbPrivs((prev) => {
      const entry = prev.get(selectedDb);
      if (!entry) return prev;
      const edited = new Set(entry.edited);
      if (edited.has(priv)) {
        edited.delete(priv);
      } else {
        edited.add(priv);
      }
      const next = new Map(prev);
      next.set(selectedDb, { ...entry, edited });
      return next;
    });
    setSuccessMsg(null);
  };

  const hasGlobalChanges = !setsEqual(currentGlobalPrivs, editedGlobalPrivs)
    || hasGrantOption !== editedGrantOption;
  const hasDbChanges = dirtyDbs.length > 0;
  const hasChanges = hasGlobalChanges || hasDbChanges;

  /**
   * The statements Apply would run, in the order it would run them.
   *
   * Separated from running them so the same list can be shown for approval
   * first. GRANT and REVOKE cannot be rolled back, so the preview is the only
   * point at which the whole change can still be reconsidered (#439).
   */
  const buildStatements = (): string[] => {
    const userSpec = `${quoteStringLiteral(user)}@${quoteStringLiteral(host)}`;
    // Collected separately so every revoke can be emitted before any grant.
    // Interleaving them by scope meant a global GRANT could land before a
    // database REVOKE, so an interruption in between left the user with more
    // access than intended — the wrong direction to fail in (#439).
    const revokes: string[] = [];
    const grants: string[] = [];

    // Global privilege changes
    if (hasGlobalChanges) {
      const toGrant = [...editedGlobalPrivs].filter(
        (p) => !currentGlobalPrivs.has(p),
      );
      const toRevoke = [...currentGlobalPrivs].filter(
        (p) => !editedGlobalPrivs.has(p),
      );

      if (toRevoke.length > 0) {
        revokes.push(`REVOKE ${toRevoke.join(", ")} ON *.* FROM ${userSpec}`);
      }
      if (toGrant.length > 0) {
        grants.push(`GRANT ${toGrant.join(", ")} ON *.* TO ${userSpec}`);
      }
      if (editedGrantOption && !hasGrantOption) {
        grants.push(`GRANT GRANT OPTION ON *.* TO ${userSpec}`);
      } else if (!editedGrantOption && hasGrantOption) {
        revokes.push(`REVOKE GRANT OPTION ON *.* FROM ${userSpec}`);
      }
    }

    // Database privilege changes, for every database with pending edits —
    // not only the one currently on screen (#441).
    for (const db of dirtyDbs) {
      const entry = dbPrivs.get(db);
      if (!entry) continue;
      const toGrant = [...entry.edited].filter((p) => !entry.current.has(p));
      const toRevoke = [...entry.current].filter((p) => !entry.edited.has(p));
      const dbScope = `${quoteIdentifier(db)}.*`;

      if (toRevoke.length > 0) {
        revokes.push(`REVOKE ${toRevoke.join(", ")} ON ${dbScope} FROM ${userSpec}`);
      }
      if (toGrant.length > 0) {
        grants.push(`GRANT ${toGrant.join(", ")} ON ${dbScope} TO ${userSpec}`);
      }
    }

    const statements = [...revokes, ...grants];
    if (statements.length > 0) {
      statements.push("FLUSH PRIVILEGES");
    }
    return statements;
  };

  const applyChanges = async (statements: string[]) => {
    setApplying(true);
    setError(null);
    setSuccessMsg(null);

    // GRANT and REVOKE each force an implicit commit, so this sequence cannot
    // be made atomic — a transaction around it would change nothing, and a
    // GRANT survives a ROLLBACK. What is left is to fail in the safer
    // direction and to say exactly what happened (#439).
    //
    // Every revoke is emitted before any grant, so an interruption leaves the
    // user with less access than intended rather than more. Being locked out
    // of a schema is recoverable and obvious; retaining a privilege an admin
    // believed they had removed is neither.
    if (
      !(await confirmDestructive({
        connectionId,
        sql: statements,
        action: statements.length === 1
          ? "Change privileges?"
          : `Apply ${statements.length} privilege changes?`,
      }))
    ) return;

    const applied: string[] = [];
    // Held rather than set immediately: the re-read below calls loadGrants,
    // which clears the error as it starts, and would wipe this report.
    let failureReport: string | null = null;
    try {
      for (const sql of statements) {
        await runStatement({ connectionId, sql, origin: "admin" });
        applied.push(sql);
      }
      setSuccessMsg(
        statements.length === 1
          ? "Privileges updated"
          : `Privileges updated — ${statements.length} statements applied`,
      );
    } catch (e) {
      failureReport = describePartialFailure(statements, applied, e);
    } finally {
      // Always re-read, on success and on failure alike. After a partial
      // failure the server holds a state nobody chose, and showing the
      // optimistic edit as though it were real is the worst of the options.
      setDbPrivs(new Map());
      await loadGrants();
      if (failureReport) setError(failureReport);
      setApplying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--color-text-muted)]" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {pendingStatements && (
        <SQLPreviewDialog
          sql={pendingStatements.length > 0
            ? pendingStatements.map((sql) => `${sql};`).join("\n")
            : "-- No privilege changes to apply"}
          onClose={() => setPendingStatements(null)}
          onExecute={() => {
            const statements = pendingStatements;
            setPendingStatements(null);
            void applyChanges(statements);
          }}
        />
      )}
      {error && (
        <div className="whitespace-pre-line rounded border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-400">
          {error}
        </div>
      )}
      {successMsg && (
        <div className="flex items-center gap-1.5 rounded border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-400">
          <Check className="h-3.5 w-3.5" />
          {successMsg}
        </div>
      )}

      {/* Global Privileges */}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">
          Global Privileges (*. *)
        </h3>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-3 sm:grid-cols-3 lg:grid-cols-4">
          {GLOBAL_PRIVILEGES.map((priv) => (
            <label
              key={priv}
              className="flex items-center gap-1.5 text-xs text-[var(--color-text-primary)]"
            >
              <input
                type="checkbox"
                checked={editedGlobalPrivs.has(priv)}
                onChange={() => toggleGlobalPriv(priv)}
                className="rounded border-[var(--color-border)]"
              />
              <span
                className={cn(
                  "font-mono text-[11px]",
                  editedGlobalPrivs.has(priv) !== currentGlobalPrivs.has(priv)
                    ? "text-yellow-400"
                    : "",
                )}
              >
                {priv}
              </span>
            </label>
          ))}
          <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-primary)]">
            <input
              type="checkbox"
              checked={editedGrantOption}
              onChange={() => {
                setEditedGrantOption(!editedGrantOption);
                setSuccessMsg(null);
              }}
              className="rounded border-[var(--color-border)]"
            />
            <span
              className={cn(
                "font-mono text-[11px]",
                editedGrantOption !== hasGrantOption ? "text-yellow-400" : "",
              )}
            >
              GRANT OPTION
            </span>
          </label>
        </div>
      </div>

      {/* Database Privileges */}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">
          Database Privileges
        </h3>
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-3">
          <div className="mb-3 flex items-center gap-2">
            <Database className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
            <select
              value={selectedDb}
              onChange={(e) => setSelectedDb(e.target.value)}
              className="h-7 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none"
            >
              <option value="">Select a database…</option>
              {databases.map((db) => (
                <option key={db} value={db}>
                  {
                    /* Edits on a database you have switched away from are kept
                      and will be applied, so say which those are. */
                  }
                  {dirtyDbs.includes(db) ? `${db} •` : db}
                </option>
              ))}
            </select>
            {dbLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-text-muted)]" />}
            {dirtyDbs.length > 0 && (
              <span className="text-[10px] text-yellow-400">
                {dirtyDbs.length === 1
                  ? `unapplied changes on ${dirtyDbs[0]}`
                  : `unapplied changes on ${dirtyDbs.length} databases`}
              </span>
            )}
          </div>

          {selectedDb
            ? (
              <div
                data-testid="db-privileges"
                className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 lg:grid-cols-4"
              >
                {DATABASE_PRIVILEGES.map((priv) => (
                  <label
                    key={priv}
                    className="flex items-center gap-1.5 text-xs text-[var(--color-text-primary)]"
                  >
                    <input
                      type="checkbox"
                      checked={editedDbPrivs.has(priv)}
                      onChange={() => toggleDbPriv(priv)}
                      className="rounded border-[var(--color-border)]"
                    />
                    <span
                      className={cn(
                        "font-mono text-[11px]",
                        editedDbPrivs.has(priv) !== currentDbPrivs.has(priv)
                          ? "text-yellow-400"
                          : "",
                      )}
                    >
                      {priv}
                    </span>
                  </label>
                ))}
              </div>
            )
            : (
              <p className="text-xs text-[var(--color-text-muted)]">
                Select a database to manage its privileges
              </p>
            )}
        </div>
      </div>

      {/* Apply */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPendingStatements(buildStatements())}
          disabled={!hasChanges || applying}
          className="flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-50 transition-colors"
        >
          {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Apply Changes
        </button>
        {hasChanges && (
          <button
            onClick={() => {
              setEditedGlobalPrivs(new Set(currentGlobalPrivs));
              setEditedGrantOption(hasGrantOption);
              // Every database, not only the one on screen — otherwise Reset
              // leaves edits behind on databases the user has switched away
              // from, and Apply would still send them.
              setDbPrivs((prev) => {
                const next = new Map(prev);
                for (const [db, entry] of prev) {
                  next.set(db, { current: entry.current, edited: new Set(entry.current) });
                }
                return next;
              });
              setSuccessMsg(null);
            }}
            className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-3.5 w-3.5" />
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Explain a half-applied privilege change.
 *
 * Reporting only the error from the statement that failed leaves the user
 * unable to tell what the server now holds — and since none of it can be
 * rolled back, that is the one thing they need to know.
 */
