import { AlertTriangle, Check, Database } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { answerApproval } from "../../hooks/useAgentRequests";
import { type PendingApproval, useAgentStore } from "../../stores/agentStore";

/**
 * The question SQLPilot always asks itself.
 *
 * Whatever the harness has been told it may do — `--yolo`, `--allow-all`, a
 * permission the user granted it once and forgot — a change to a shared
 * database is approved here, in this window, or it does not happen. There is
 * no setting that turns this off, which is the reason the whole integration
 * can be built on someone else's agent.
 *
 * For a write, the statement has already run inside a transaction that has not
 * been committed, so the row count is measured rather than estimated. That is
 * the difference between "this will update some rows" and "this updated 4.2
 * million rows, keep it?" — and it is the only version of the question a
 * person can actually answer.
 */

export interface ApprovalDialogProps {
  /** Provided by tests; the store supplies it in the app. */
  approval?: PendingApproval | null;
}

function Rows({ approval }: { approval: PendingApproval }) {
  if (approval.change === "schema") {
    return (
      <p className="text-xs text-[var(--color-text-secondary)]">
        A schema change cannot be tried and undone — the server commits before it runs. This is being approved{" "}
        <strong>before</strong> it happens.
      </p>
    );
  }

  const rows = approval.rowsAffected ?? 0;
  const many = rows >= 1000;
  return (
    <p
      className={many
        ? "text-xs font-semibold text-amber-400"
        : "text-xs text-[var(--color-text-secondary)]"}
    >
      {rows === 0
        ? "This changes no rows."
        : `This changes ${rows.toLocaleString()} row${rows === 1 ? "" : "s"}.`}{" "}
      <span className="font-normal text-[var(--color-text-muted)]">
        Already run, not yet committed — rejecting puts everything back.
      </span>
    </p>
  );
}

export function ApprovalDialog({ approval: given }: ApprovalDialogProps = {}) {
  const fromStore = useAgentStore((s) => s.approval);
  const clearApproval = useAgentStore((s) => s.clearApproval);
  const approval = given ?? fromStore;
  const [sending, setSending] = useState(false);

  const decide = useCallback(
    async (approved: boolean) => {
      if (!approval || sending) return;
      setSending(true);
      try {
        await answerApproval(approval.id, approved);
      } finally {
        setSending(false);
        clearApproval();
      }
    },
    [approval, sending, clearApproval],
  );

  // Escape rejects. A dialog that vanished without an answer would leave the
  // transaction open until it timed out, and the agent waiting on it.
  useEffect(() => {
    if (!approval) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void decide(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approval, decide]);

  if (!approval) return null;

  const production = approval.environment === "production";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative w-[560px] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-xl">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <AlertTriangle
            className={production ? "h-4 w-4 text-red-400" : "h-4 w-4 text-amber-400"}
          />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {approval.change === "schema"
              ? "The agent wants to change the schema"
              : "The agent wants to change data"}
          </h2>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2 text-xs">
            <Database className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
            <span className="text-[var(--color-text-primary)]">{approval.connection}</span>
            {approval.database && <span className="text-[var(--color-text-muted)]">/ {approval.database}</span>}
            <span
              data-testid="approval-environment"
              className={production
                ? "rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-400"
                : "rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-muted)]"}
            >
              {approval.environment}
            </span>
          </div>

          {approval.reason && (
            <p className="text-xs italic text-[var(--color-text-secondary)]">
              The agent says: {approval.reason}
            </p>
          )}

          <pre className="max-h-48 overflow-auto rounded bg-[var(--color-bg-secondary)] p-2 font-mono text-[11px] text-[var(--color-text-primary)]">
{approval.sql}
          </pre>

          <Rows approval={approval} />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <button
            type="button"
            onClick={() => void decide(false)}
            disabled={sending}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            {approval.change === "schema" ? "Don't run it" : "Discard"}
          </button>
          <button
            type="button"
            onClick={() => void decide(true)}
            disabled={sending}
            className={production
              ? "flex items-center gap-1 rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
              : "flex items-center gap-1 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500"}
          >
            <Check className="h-3 w-3" />
            {approval.change === "schema" ? "Run it" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
