import { AlertTriangle, Loader2, X } from "lucide-react";
import { useState } from "react";
import { buildSetVariable, scopesFor, survivesRestart, type VariableScope } from "../../lib/admin/set-variable";
import { runStatement } from "../../lib/run-statement";
import type { ServerFlavour } from "../../lib/server-flavour";
import { confirmDestructive } from "../../stores/productionGuardStore";
import type { ServerVariable } from "../../types";

/**
 * Changing one server variable.
 *
 * FR-7.2.2 asks for inline editing of settable variables. The tab showed
 * values as read-only text, so changing one meant leaving the panel (#438).
 *
 * The dialog is explicit about two things the server will not tell you
 * afterwards. `SET GLOBAL` does not survive a restart — the value holds until
 * the server stops and then reverts to the config file, which is the thing
 * people are surprised by. And `SET PERSIST`, which does survive, is MySQL's
 * alone: MariaDB has no equivalent, so it is not offered there rather than
 * offered and then rejected.
 */

const SCOPE_LABEL: Record<VariableScope, string> = {
  global: "Globally (until restart)",
  session: "This session only",
  persist: "Globally and persisted",
};

export interface SetVariableDialogProps {
  variable: ServerVariable | null;
  connectionId: string;
  flavour: ServerFlavour;
  onClose: () => void;
  onChanged: () => void;
}

export function SetVariableDialog(
  { variable, connectionId, flavour, onClose, onChanged }: SetVariableDialogProps,
) {
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<VariableScope>("global");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which variable the draft belongs to, so opening a different one reseeds it.
  const [seededFor, setSeededFor] = useState<string | null>(null);

  if (!variable) return null;

  if (seededFor !== variable.name) {
    setSeededFor(variable.name);
    setValue(variable.value);
    setScope("global");
    setError(null);
    return null;
  }

  const scopes = scopesFor(flavour);
  const unchanged = value === variable.value;

  let statement: string | null = null;
  let invalidName: string | null = null;
  try {
    statement = buildSetVariable(variable.name, value, scope);
  } catch (e) {
    invalidName = String(e);
  }

  const handleApply = async () => {
    if (!statement) return;
    setSaving(true);
    setError(null);
    try {
      if (
        !(await confirmDestructive({
          connectionId,
          sql: statement,
          action: `Set ${variable.name} on production?`,
          detail: statement,
        }))
      ) {
        return;
      }
      await runStatement({ connectionId, sql: statement, origin: "admin" });
      onChanged();
      onClose();
    } catch (e) {
      // 1238 is the server saying the variable is read-only, which is the only
      // way MySQL reports it — there is no column to check first.
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const field =
    "h-8 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 font-mono text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[460px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="font-mono text-sm font-semibold text-[var(--color-text-primary)]">
            {variable.name}
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
          {variable.description && (
            <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {variable.description}
            </p>
          )}

          <div>
            <label
              htmlFor="set-var-value"
              className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]"
            >
              Value
            </label>
            <input
              id="set-var-value"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label
              htmlFor="set-var-scope"
              className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]"
            >
              Scope
            </label>
            <select
              id="set-var-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as VariableScope)}
              className={`${field} font-sans`}
            >
              {scopes.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
            </select>
          </div>

          {!survivesRestart(scope) && scope === "global" && (
            <p className="flex items-start gap-1.5 rounded border border-yellow-500/40 bg-yellow-500/10 p-2 text-[11px] text-yellow-300">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                This holds until the server restarts, then reverts to the config file.
                {flavour === "mariadb"
                  ? " MariaDB has no SET PERSIST — to make it permanent, edit the server's configuration."
                  : " Set the scope to persist it."}
              </span>
            </p>
          )}

          {statement && !unchanged && (
            <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2 font-mono text-[10px] text-[var(--color-text-muted)]">
              {statement};
            </pre>
          )}

          {invalidName && <p role="alert" className="text-[11px] text-red-400">{invalidName}</p>}
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
            onClick={() => void handleApply()}
            disabled={saving || unchanged || !statement}
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
