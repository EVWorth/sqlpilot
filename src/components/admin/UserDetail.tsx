import { ChevronRight, Database, KeyRound, Loader2, Pencil, Shield, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { quoteStringLiteral } from "../../lib/sql-quote";
import { api } from "../../lib/tauri-api";
import { cn } from "../../lib/utils";
import { PrivilegesEditor } from "./PrivilegesEditor";
import type { DetailTab } from "./UserManagement";
import { categorizeGrants, type ParsedGrant, parseGrantStatements } from "./userPrivileges";

export function UserDetail({
  connectionId,
  user,
  host,
  confirmDrop,
  setConfirmDrop,
  onDropUser,
  onChangePassword,
  onEditUser,
}: {
  connectionId: string;
  user: string;
  host: string;
  confirmDrop: boolean;
  setConfirmDrop: (v: boolean) => void;
  onDropUser: () => void;
  onChangePassword: () => void;
  onEditUser: () => void;
}) {
  const [detailTab, setDetailTab] = useState<DetailTab>("grants");

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-2">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-brand-400" />
          <span className="font-mono text-sm font-medium text-[var(--color-text-primary)]">
            {user}@{host}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onEditUser}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </button>
          <button
            onClick={onChangePassword}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Change Password
          </button>
          {confirmDrop
            ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={onDropUser}
                  className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500"
                >
                  Confirm Drop
                </button>
                <button
                  onClick={() => setConfirmDrop(false)}
                  className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                >
                  Cancel
                </button>
              </div>
            )
            : (
              <button
                onClick={() => setConfirmDrop(true)}
                className="flex items-center gap-1 rounded border border-red-500/30 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Drop User
              </button>
            )}
        </div>
      </div>

      {/* Detail tabs */}
      <div className="flex border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1">
        <button
          onClick={() => setDetailTab("grants")}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors",
            detailTab === "grants"
              ? "border-b-2 border-brand-500 text-brand-400"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
          )}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          Grants
        </button>
        <button
          onClick={() => setDetailTab("privileges")}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors",
            detailTab === "privileges"
              ? "border-b-2 border-brand-500 text-brand-400"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
          )}
        >
          <Shield className="h-3.5 w-3.5" />
          Privileges
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {detailTab === "grants" ? <GrantsView connectionId={connectionId} user={user} host={host} /> : (
          <PrivilegesEditor
            connectionId={connectionId}
            user={user}
            host={host}
          />
        )}
      </div>
    </div>
  );
}

// ─── Grants View ──────────────────────────────────────────────────────────

function GrantsView({
  connectionId,
  user,
  host,
}: {
  connectionId: string;
  user: string;
  host: string;
}) {
  const [rawGrants, setRawGrants] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .executeQuery(
        connectionId,
        `SHOW GRANTS FOR ${quoteStringLiteral(user)}@${quoteStringLiteral(host)}`,
      )
      .then((results) => {
        if (results.length > 0) {
          setRawGrants(results[0].rows.map((row) => String(row[0] ?? "")));
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [connectionId, user, host]);

  const parsed = useMemo(() => parseGrantStatements(rawGrants), [rawGrants]);
  const categorized = useMemo(() => categorizeGrants(parsed), [parsed]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--color-text-muted)]" />
      </div>
    );
  }

  if (error) {
    return <div className="p-4 text-xs text-red-400">{error}</div>;
  }

  return (
    <div className="space-y-4 p-4">
      {/* Global Privileges */}
      {categorized.global.length > 0 && (
        <GrantSection
          title="Global Privileges"
          scope="*.*"
          grants={categorized.global}
        />
      )}

      {/* Database Privileges */}
      {categorized.database.size > 0 && (
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-secondary)]">
            <Database className="h-3.5 w-3.5" />
            Database Privileges
          </h3>
          {Array.from(categorized.database.entries()).map(([db, grant]) => (
            <GrantSection
              key={db}
              title={db}
              scope={`${db}.*`}
              grants={[grant]}
            />
          ))}
        </div>
      )}

      {/* Table Privileges */}
      {categorized.table.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">
            Table-specific Privileges
          </h3>
          {categorized.table.map((g, i) => (
            <GrantSection
              key={i}
              title={g.scope}
              scope={g.scope}
              grants={[g]}
            />
          ))}
        </div>
      )}

      {/* Raw Statements */}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">
          Raw GRANT Statements
        </h3>
        <div className="space-y-1">
          {rawGrants.map((g, i) => (
            <pre
              key={i}
              className="whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-[11px] font-mono text-[var(--color-text-secondary)]"
            >
              {g}
            </pre>
          ))}
        </div>
      </div>
    </div>
  );
}

function GrantSection({
  title,
  scope: _scope,
  grants,
}: {
  title: string;
  scope: string;
  grants: ParsedGrant[];
}) {
  return (
    <div className="mb-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-primary)]">
        <ChevronRight className="h-3 w-3 text-brand-400" />
        {title}
      </div>
      {grants.map((g, i) => (
        <div key={i} className="ml-4">
          <div className="flex flex-wrap gap-1.5">
            {g.privileges.map((priv) => (
              <span
                key={priv}
                className="inline-flex rounded bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-medium text-brand-400"
              >
                {priv}
              </span>
            ))}
            {g.grantOption && (
              <span className="inline-flex rounded bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                WITH GRANT OPTION
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Privileges Editor ────────────────────────────────────────────────────

/** One database's granted privileges, and the pending edit of them. */
