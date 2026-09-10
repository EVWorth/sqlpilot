import { Loader2, X } from "lucide-react";
import { useState } from "react";
import { type AlterUserOptions, buildAlterUserStatements, type PasswordExpiry } from "../../lib/admin/alter-user";
import { runStatement } from "../../lib/run-statement";
import { confirmDestructive } from "../../stores/productionGuardStore";

/**
 * Editing everything about a user except its password.
 *
 * FR-7.1.3 promised host, lock and expiry were editable; only the password
 * ever was, so unlocking an account meant leaving the app and writing SQL
 * (#436).
 *
 * Every control defaults to "leave unchanged", and nothing is emitted for a
 * control the admin did not touch. That is not tidiness: on MariaDB the panel
 * cannot read lock or expiry state at all (#440), so a form pre-filled with
 * the current values would be pre-filled with guesses — and a wrong guess here
 * unlocks an account somebody locked on purpose.
 *
 * Lock is two explicit choices rather than a checkbox for the same reason. A
 * checkbox has to start somewhere, and there is no honest place to start it.
 */

const UNCHANGED = "unchanged";

export interface EditUserDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  connectionId: string;
  username: string;
  host: string;
}

export function EditUserDialog(
  { isOpen, onClose, onSaved, connectionId, username, host }: EditUserDialogProps,
) {
  const [lock, setLock] = useState<string>(UNCHANGED);
  const [expiry, setExpiry] = useState<string>(UNCHANGED);
  const [expiryDays, setExpiryDays] = useState("90");
  const [maxConnections, setMaxConnections] = useState("");
  const [newHost, setNewHost] = useState(host);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const options: AlterUserOptions = {
    username,
    host,
    lock: lock === UNCHANGED ? undefined : (lock as "lock" | "unlock"),
    expiry: expiry === UNCHANGED
      ? undefined
      : expiry === "interval"
      ? { days: Number(expiryDays) || 1 } satisfies PasswordExpiry
      : (expiry as PasswordExpiry),
    maxConnections: maxConnections.trim() === "" ? undefined : Number(maxConnections),
    newHost: newHost.trim() === host ? undefined : newHost.trim(),
  };
  const statements = buildAlterUserStatements(options);

  const handleSave = async () => {
    if (statements.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Once for the edit, not once per statement.
      if (
        !(await confirmDestructive({
          connectionId,
          sql: statements,
          action: `Change ${username}@${host}?`,
          detail: statements.join("\n"),
        }))
      ) {
        setSaving(false);
        return;
      }

      // One at a time, so a failure names the change that failed. ALTER USER
      // commits as it runs, so a half-applied edit is a real state and saying
      // "it failed" would be wrong about the part that took.
      const applied: string[] = [];
      for (const sql of statements) {
        try {
          await runStatement({ connectionId, sql, origin: "admin" });
          applied.push(sql);
        } catch (e) {
          setError(
            applied.length === 0
              ? `Nothing was changed: ${String(e)}`
              : `Applied ${applied.length} of ${statements.length} changes, then: ${String(e)}`,
          );
          onSaved();
          return;
        }
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const field =
    "h-8 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none";
  const label = "mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[440px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Edit {username}@{host}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div>
            <label htmlFor="edit-user-lock" className={label}>Account</label>
            <select
              id="edit-user-lock"
              value={lock}
              onChange={(e) => setLock(e.target.value)}
              className={field}
            >
              <option value={UNCHANGED}>Leave unchanged</option>
              <option value="lock">Lock</option>
              <option value="unlock">Unlock</option>
            </select>
          </div>

          <div>
            <label htmlFor="edit-user-expiry" className={label}>Password expiry</label>
            <div className="flex gap-2">
              <select
                id="edit-user-expiry"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className={field}
              >
                <option value={UNCHANGED}>Leave unchanged</option>
                <option value="now">Expire now</option>
                <option value="interval">Expire every…</option>
                <option value="never">Never expire</option>
                <option value="default">Server default</option>
              </select>
              {expiry === "interval" && (
                <input
                  type="number"
                  min={1}
                  aria-label="Days"
                  value={expiryDays}
                  onChange={(e) => setExpiryDays(e.target.value)}
                  className={`${field} w-24`}
                />
              )}
            </div>
          </div>

          <div>
            <label htmlFor="edit-user-max" className={label}>
              Max connections <span className="text-[var(--color-text-muted)]">(blank: unchanged, 0: unlimited)</span>
            </label>
            <input
              id="edit-user-max"
              type="number"
              min={0}
              value={maxConnections}
              onChange={(e) => setMaxConnections(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="edit-user-host" className={label}>
              Host <span className="text-[var(--color-text-muted)]">(changing this renames the user)</span>
            </label>
            <input
              id="edit-user-host"
              type="text"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              className={field}
            />
          </div>

          {statements.length > 0 && (
            <div>
              <span className={label}>Will run</span>
              <pre className="max-h-28 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2 font-mono text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                {statements.join(";\n")};
              </pre>
            </div>
          )}

          {error && <p role="alert" className="text-[11px] text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || statements.length === 0}
            className="flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
