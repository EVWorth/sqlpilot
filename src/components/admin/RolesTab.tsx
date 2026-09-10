import { Loader2, Plus, RefreshCw, Shield, Trash2, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildClearDefaultRole,
  buildCreateRole,
  buildDropRole,
  buildGrantRole,
  buildRevokeRole,
  buildSetDefaultRole,
  listRoleGrantsQuery,
  listRolesQuery,
  type RoleGrant,
  type RoleInfo,
} from "../../lib/admin/roles";
import { runStatement } from "../../lib/run-statement";
import { serverFlavour } from "../../lib/server-flavour";
import { useConnectionStore } from "../../stores/connectionStore";
import { confirmDestructive } from "../../stores/productionGuardStore";

/**
 * Roles: creating them, and deciding who holds them.
 *
 * FR-7.1.6 asked for role management and there was none (#435). The SQL and
 * the catalog queries fork between MySQL and MariaDB at almost every point —
 * see lib/admin/roles.ts, which carries the comparison.
 *
 * A separate tab rather than more of UserManagement, which was 1135 lines
 * before #432 and does not need to grow back.
 */

export function RolesTab({ connectionId }: { connectionId: string }) {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [grants, setGrants] = useState<RoleGrant[]>([]);
  const [users, setUsers] = useState<{ user: string; host: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newRole, setNewRole] = useState("");
  const [selected, setSelected] = useState<RoleInfo | null>(null);
  const [grantTo, setGrantTo] = useState("");

  const flavour = serverFlavour(
    useConnectionStore((s) => s.activeConnections).find((c) => c.id === connectionId)
      ?.server_version,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [roleRows, grantRows, userRows] = await Promise.all([
        runStatement({ connectionId, sql: listRolesQuery(flavour), origin: "internal" }),
        runStatement({ connectionId, sql: listRoleGrantsQuery(flavour), origin: "internal" }),
        runStatement({
          connectionId,
          // Roles live in mysql.user too, so the assignable list excludes
          // anything this server would call a role.
          sql: "SELECT User, Host FROM mysql.user ORDER BY User, Host",
          origin: "internal",
        }),
      ]);

      const asRoles = (roleRows[0]?.rows ?? []).map((r) => ({
        name: String(r[0] ?? ""),
        host: String(r[1] ?? ""),
      }));
      setRoles(asRoles);
      setGrants(
        (grantRows[0]?.rows ?? []).map((r) => ({
          role: String(r[0] ?? ""),
          user: String(r[1] ?? ""),
          host: String(r[2] ?? ""),
        })),
      );
      const roleNames = new Set(asRoles.map((r) => r.name));
      setUsers(
        (userRows[0]?.rows ?? [])
          .map((r) => ({ user: String(r[0] ?? ""), host: String(r[1] ?? "") }))
          .filter((u) => !roleNames.has(u.user)),
      );
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId, flavour]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run one statement, refresh, and report rather than throw. */
  const apply = async (sql: string, action: string, done: string) => {
    try {
      if (!(await confirmDestructive({ connectionId, sql, action, detail: sql }))) return;
      await runStatement({ connectionId, sql, origin: "admin" });
      setNotice(done);
      await load();
    } catch (e) {
      setNotice(String(e));
    }
  };

  const holders = useMemo(
    () => selected ? grants.filter((g) => g.role === selected.name) : [],
    [grants, selected],
  );

  const btn =
    "flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors";

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-[var(--color-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading roles…
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 border-r border-[var(--color-border)]">
        <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
          <input
            type="text"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newRole.trim()) {
                void apply(
                  buildCreateRole(newRole.trim()),
                  `Create role ${newRole.trim()}?`,
                  `Created ${newRole.trim()}.`,
                ).then(() => setNewRole(""));
              }
            }}
            placeholder="New role name"
            aria-label="New role name"
            className="h-7 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none"
          />
          <button
            onClick={() =>
              void apply(
                buildCreateRole(newRole.trim()),
                `Create role ${newRole.trim()}?`,
                `Created ${newRole.trim()}.`,
              ).then(() => setNewRole(""))}
            disabled={!newRole.trim()}
            title="Create role"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => void load()}
            title="Refresh"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="overflow-y-auto">
          {roles.length === 0
            ? (
              <p className="p-3 text-center text-[11px] text-[var(--color-text-muted)]">
                No roles yet
              </p>
            )
            : roles.map((r) => (
              <button
                key={`${r.name}@${r.host}`}
                onClick={() => setSelected(r)}
                className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-[var(--color-bg-tertiary)] ${
                  selected?.name === r.name
                    ? "bg-[var(--color-bg-tertiary)] text-brand-400"
                    : "text-[var(--color-text-secondary)]"
                }`}
              >
                <Shield className="h-3 w-3 shrink-0" />
                <span className="truncate">{r.name}</span>
                <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                  {grants.filter((g) => g.role === r.name).length}
                </span>
              </button>
            ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {error && <p role="alert" className="mb-2 text-[11px] text-red-400">{error}</p>}
        {notice && (
          <p role="status" className="mb-2 flex items-start gap-1 text-[11px] text-[var(--color-text-secondary)]">
            <span className="flex-1">{notice}</span>
            <button
              onClick={() =>
                setNotice(null)}
              aria-label="Dismiss"
              className="text-[var(--color-text-muted)]"
            >
              <X className="h-3 w-3" />
            </button>
          </p>
        )}

        {!selected
          ? (
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Select a role to see who holds it.
            </p>
          )
          : (
            <>
              <div className="mb-3 flex items-center gap-2">
                <h3 className="font-mono text-sm text-[var(--color-text-primary)]">
                  {selected.name}
                </h3>
                <button
                  onClick={() =>
                    void apply(
                      buildDropRole(selected),
                      `Drop role ${selected.name}?`,
                      `Dropped ${selected.name}.`,
                    ).then(() => setSelected(null))}
                  className={`${btn} ml-auto text-red-400`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Drop role
                </button>
              </div>

              <div className="mb-3 flex items-center gap-2">
                <select
                  value={grantTo}
                  onChange={(e) => setGrantTo(e.target.value)}
                  aria-label="Grant to"
                  className="h-7 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-xs text-[var(--color-text-primary)]"
                >
                  <option value="">Choose a user…</option>
                  {users.map((u) => (
                    <option key={`${u.user}@${u.host}`} value={`${u.user} ${u.host}`}>
                      {u.user}@{u.host}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const [user, host] = grantTo.split(" ");
                    if (!user) return;
                    void apply(
                      buildGrantRole(selected, user, host),
                      `Grant ${selected.name} to ${user}@${host}?`,
                      `Granted ${selected.name} to ${user}@${host}.`,
                    );
                  }}
                  disabled={!grantTo}
                  className={`${btn} disabled:opacity-40`}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Grant
                </button>
              </div>

              {holders.length === 0
                ? <p className="text-[11px] text-[var(--color-text-muted)]">Nobody holds this role.</p>
                : (
                  <table className="w-full text-xs">
                    <tbody>
                      {holders.map((g) => (
                        <tr key={`${g.user}@${g.host}`} className="border-b border-[var(--color-border)]">
                          <td className="py-1.5 font-mono text-[var(--color-text-primary)]">
                            {g.user}@{g.host}
                          </td>
                          <td className="py-1.5 text-right">
                            <button
                              onClick={() =>
                                void apply(
                                  buildSetDefaultRole(selected, g.user, g.host, flavour),
                                  `Make ${selected.name} the default role for ${g.user}?`,
                                  `${selected.name} is now ${g.user}@${g.host}'s default role.`,
                                )}
                              className="mr-2 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                              title="Activate this role automatically on login"
                            >
                              Set default
                            </button>
                            <button
                              onClick={() =>
                                void apply(
                                  buildClearDefaultRole(g.user, g.host, flavour),
                                  `Clear the default role for ${g.user}?`,
                                  `Cleared ${g.user}@${g.host}'s default role.`,
                                )}
                              className="mr-2 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                              title="Stop activating a role automatically on login"
                            >
                              Clear default
                            </button>
                            <button
                              onClick={() =>
                                void apply(
                                  buildRevokeRole(selected, g.user, g.host),
                                  `Revoke ${selected.name} from ${g.user}@${g.host}?`,
                                  `Revoked ${selected.name} from ${g.user}@${g.host}.`,
                                )}
                              className="rounded px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-500/10"
                            >
                              Revoke
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </>
          )}
      </div>
    </div>
  );
}
