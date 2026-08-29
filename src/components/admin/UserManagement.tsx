import {
  AlertTriangle,
  Check,
  ChevronRight,
  Database,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { quoteIdentifier, quoteStringLiteral } from "../../lib/sql-quote";
import { api } from "../../lib/tauri-api";
import { cn } from "../../lib/utils";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { CreateUserDialog } from "./CreateUserDialog";
import {
  categorizeGrants,
  DATABASE_PRIVILEGES,
  GLOBAL_PRIVILEGES,
  type ParsedGrant,
  parseGrantStatements,
} from "./userPrivileges";

interface UserRow {
  user: string;
  host: string;
  accountLocked: string | null;
  passwordExpired: string | null;
  passwordLastChanged: string | null;
}

type DetailTab = "grants" | "privileges";

interface UserManagementProps {
  connectionId: string;
}

export function UserManagement({ connectionId }: UserManagementProps) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserRow | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  // True when the lock/expiry columns could not be read, so the UI can say so
  // rather than showing every account as unremarkable (#440).
  const [statusUnavailable, setStatusUnavailable] = useState(false);

  const fetchUsers = useCallback(async () => {
    let degraded = false;
    try {
      const results = await api.executeQuery(
        connectionId,
        "SELECT User, Host, account_locked, password_expired, password_last_changed FROM mysql.user ORDER BY User, Host",
      );
      if (results.length > 0 && results[0].rows.length > 0) {
        setUsers(
          results[0].rows.map((row) => ({
            user: String(row[0] ?? ""),
            host: String(row[1] ?? ""),
            accountLocked: row[2] != null ? String(row[2]) : null,
            passwordExpired: row[3] != null ? String(row[3]) : null,
            passwordLastChanged: row[4] != null ? String(row[4]) : null,
          })),
        );
        setError(null);
        setStatusUnavailable(false);
        return;
      }
    } catch (e) {
      // Fallback for MariaDB / older MySQL, which do not have all of those
      // columns — and for a grant that exposes only some of them. Recorded
      // rather than discarded: the fallback cannot tell whether an account is
      // locked, and rendering that as "not locked" is the dangerous reading
      // on an admin screen (#440).
      console.warn("Full mysql.user query failed, falling back", e);
      degraded = true;
    }
    try {
      const results = await api.executeQuery(
        connectionId,
        "SELECT DISTINCT User, Host FROM mysql.user ORDER BY User, Host",
      );
      if (results.length > 0) {
        setUsers(
          results[0].rows.map((row) => ({
            user: String(row[0] ?? ""),
            host: String(row[1] ?? ""),
            accountLocked: null,
            passwordExpired: null,
            passwordLastChanged: null,
          })),
        );
        setError(null);
        setStatusUnavailable(degraded);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    setLoading(true);
    fetchUsers();
  }, [fetchUsers]);

  const handleRefresh = useCallback(() => {
    setLoading(true);
    fetchUsers();
  }, [fetchUsers]);

  const handleDropUser = async () => {
    if (!selectedUser) return;
    try {
      await api.executeQuery(
        connectionId,
        `DROP USER ${quoteStringLiteral(selectedUser.user)}@${quoteStringLiteral(selectedUser.host)}`,
      );
      setSelectedUser(null);
      setConfirmDrop(false);
      handleRefresh();
    } catch (e) {
      setError(String(e));
      setConfirmDrop(false);
    }
  };

  const filteredUsers = useMemo(() => {
    if (!filter) return users;
    const lc = filter.toLowerCase();
    return users.filter(
      (u) =>
        u.user.toLowerCase().includes(lc)
        || u.host.toLowerCase().includes(lc),
    );
  }, [users, filter]);

  if (loading && users.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--color-text-muted)]" />
        <span className="ml-2 text-sm text-[var(--color-text-muted)]">
          Loading users…
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left side: User list */}
      <div className="flex w-80 shrink-0 flex-col border-r border-[var(--color-border)]">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter users…"
              className="h-7 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] pl-7 pr-2 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-brand-500 focus:outline-none"
            />
          </div>
          <button
            onClick={handleRefresh}
            title="Refresh"
            className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowCreateDialog(true)}
            title="Create User"
            className="flex h-7 items-center gap-1 rounded bg-brand-600 px-2 text-xs font-medium text-white hover:bg-brand-500 transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5" />
            New
          </button>
        </div>

        {error && (
          <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-400">
            {error}
          </div>
        )}

        {/* User table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="sticky top-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-left text-[var(--color-text-secondary)]">
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Host</th>
                <th className="w-20 px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => {
                const key = `${u.user}@${u.host}`;
                const isSelected = selectedUser?.user === u.user
                  && selectedUser?.host === u.host;
                return (
                  <tr
                    key={key}
                    onClick={() => {
                      setSelectedUser(u);
                      setConfirmDrop(false);
                    }}
                    className={cn(
                      "cursor-pointer border-b border-[var(--color-border)] text-[var(--color-text-primary)] transition-colors",
                      isSelected
                        ? "bg-brand-500/10"
                        : "hover:bg-[var(--color-bg-secondary)]",
                    )}
                  >
                    <td className="px-3 py-1.5 font-mono">{u.user}</td>
                    <td className="px-3 py-1.5 text-[var(--color-text-muted)]">
                      {u.host}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex gap-1">
                        {statusUnavailable && (
                          <span
                            title="This server did not expose account_locked / password_expired, so lock and expiry state is unknown"
                            className="inline-flex items-center rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]"
                          >
                            unknown
                          </span>
                        )}
                        {u.accountLocked === "Y" && (
                          <span className="inline-flex items-center rounded bg-yellow-500/20 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                            <Lock className="mr-0.5 h-2.5 w-2.5" />
                            Locked
                          </span>
                        )}
                        {u.passwordExpired === "Y" && (
                          <span className="inline-flex items-center rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
                            <AlertTriangle className="mr-0.5 h-2.5 w-2.5" />
                            Expired
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredUsers.length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="px-3 py-6 text-center text-[var(--color-text-muted)]"
                  >
                    {filter ? "No users match the filter" : "No users found"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-muted)]">
          {users.length} user{users.length !== 1 ? "s" : ""}
        </div>
      </div>

      {/* Right side: User detail */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {selectedUser
          ? (
            <UserDetail
              connectionId={connectionId}
              user={selectedUser.user}
              host={selectedUser.host}
              confirmDrop={confirmDrop}
              setConfirmDrop={setConfirmDrop}
              onDropUser={handleDropUser}
              onChangePassword={() => setShowChangePassword(true)}
            />
          )
          : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
              Select a user to view details
            </div>
          )}
      </div>

      {/* Dialogs */}
      <CreateUserDialog
        isOpen={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        connectionId={connectionId}
        onCreated={handleRefresh}
      />
      {selectedUser && (
        <ChangePasswordDialog
          isOpen={showChangePassword}
          onClose={() => setShowChangePassword(false)}
          connectionId={connectionId}
          user={selectedUser.user}
          host={selectedUser.host}
        />
      )}
    </div>
  );
}

// ─── User Detail Panel ────────────────────────────────────────────────────

function UserDetail({
  connectionId,
  user,
  host,
  confirmDrop,
  setConfirmDrop,
  onDropUser,
  onChangePassword,
}: {
  connectionId: string;
  user: string;
  host: string;
  confirmDrop: boolean;
  setConfirmDrop: (v: boolean) => void;
  onDropUser: () => void;
  onChangePassword: () => void;
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
interface DbPrivState {
  current: Set<string>;
  edited: Set<string>;
}

/** Shared empty set, so a database with nothing selected has a stable identity. */
const EMPTY_PRIVS: Set<string> = new Set();

function PrivilegesEditor({
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
      const results = await api.executeQuery(
        connectionId,
        `SHOW GRANTS FOR ${quoteStringLiteral(user)}@${quoteStringLiteral(host)}`,
      );
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

  const applyChanges = async () => {
    setApplying(true);
    setError(null);
    setSuccessMsg(null);
    const userSpec = `${quoteStringLiteral(user)}@${quoteStringLiteral(host)}`;
    const statements: string[] = [];

    // Global privilege changes
    if (hasGlobalChanges) {
      const toGrant = [...editedGlobalPrivs].filter(
        (p) => !currentGlobalPrivs.has(p),
      );
      const toRevoke = [...currentGlobalPrivs].filter(
        (p) => !editedGlobalPrivs.has(p),
      );

      if (toRevoke.length > 0) {
        statements.push(
          `REVOKE ${toRevoke.join(", ")} ON *.* FROM ${userSpec}`,
        );
      }
      if (toGrant.length > 0) {
        statements.push(
          `GRANT ${toGrant.join(", ")} ON *.* TO ${userSpec}`,
        );
      }
      if (editedGrantOption && !hasGrantOption) {
        statements.push(
          `GRANT GRANT OPTION ON *.* TO ${userSpec}`,
        );
      } else if (!editedGrantOption && hasGrantOption) {
        statements.push(
          `REVOKE GRANT OPTION ON *.* FROM ${userSpec}`,
        );
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
        statements.push(
          `REVOKE ${toRevoke.join(", ")} ON ${dbScope} FROM ${userSpec}`,
        );
      }
      if (toGrant.length > 0) {
        statements.push(
          `GRANT ${toGrant.join(", ")} ON ${dbScope} TO ${userSpec}`,
        );
      }
    }

    if (statements.length > 0) {
      statements.push("FLUSH PRIVILEGES");
    }

    try {
      for (const sql of statements) {
        await api.executeQuery(connectionId, sql);
      }
      setSuccessMsg("Privileges updated successfully");
      // The cached per-database grants are now stale; drop them so the
      // selected database reloads from the server rather than showing the
      // optimistic edit as if it were the server's state.
      setDbPrivs(new Map());
      await loadGrants();
    } catch (e) {
      setError(String(e));
    } finally {
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
      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
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
          onClick={applyChanges}
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

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
