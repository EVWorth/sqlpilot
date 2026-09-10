import { AlertTriangle, Loader2, Lock, RefreshCw, Search, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { runStatement } from "../../lib/run-statement";
import { quoteStringLiteral } from "../../lib/sql-quote";
import { cn } from "../../lib/utils";
import { confirmDestructive } from "../../stores/productionGuardStore";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { CreateUserDialog } from "./CreateUserDialog";
import { UserDetail } from "./UserDetail";

export interface UserRow {
  user: string;
  host: string;
  accountLocked: string | null;
  passwordExpired: string | null;
  passwordLastChanged: string | null;
}

export type DetailTab = "grants" | "privileges";

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
      const results = await runStatement({
        connectionId,
        sql:
          "SELECT User, Host, account_locked, password_expired, password_last_changed FROM mysql.user ORDER BY User, Host",
        origin: "internal",
      });
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
      const results = await runStatement({
        connectionId,
        sql: "SELECT DISTINCT User, Host FROM mysql.user ORDER BY User, Host",
        origin: "internal",
      });
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
    const sql = `DROP USER ${quoteStringLiteral(selectedUser.user)}@${quoteStringLiteral(selectedUser.host)}`;
    // The panel's own confirmation asks whether to drop the user; this asks
    // whether to do it on production, which is a different question (#588).
    if (
      !(await confirmDestructive({
        connectionId,
        sql,
        action: `Drop user ${selectedUser.user}@${selectedUser.host}?`,
      }))
    ) return;
    try {
      await runStatement({ connectionId, sql, origin: "admin" });
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
