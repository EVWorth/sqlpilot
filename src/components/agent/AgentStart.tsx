import type { Ref } from "react";
import type { Harness, HarnessStatus } from "../../lib/bindings";

/**
 * What the panel offers with no session running: a Start button per harness
 * on this machine, or how to install one when there is none.
 *
 * `compact` drops the introduction, for when the last session's transcript is
 * still on screen above and the user has already read it once.
 */
export interface AgentStartProps {
  harnesses: HarnessStatus[];
  starting: Harness | null;
  onStart: (harness: Harness) => void;
  compact?: boolean;
  /** The first Start button, so the panel can move focus to it. */
  firstButtonRef?: Ref<HTMLButtonElement>;
}

export function AgentStart({ harnesses, starting, onStart, compact = false, firstButtonRef }: AgentStartProps) {
  const installed = harnesses.filter((h) => h.installed);
  return (
    <div
      className={compact
        ? "flex flex-col gap-2 border-t border-[var(--color-border)] p-3"
        : "flex flex-1 flex-col justify-center gap-3 p-4"}
    >
      {!compact && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          Run your own agent here, with the connections you have shared. SQLPilot never signs in for you and never sees
          your key — it starts the CLI you already have.
        </p>
      )}
      {installed.length === 0
        ? (
          <div className="space-y-2">
            <p className="text-xs text-[var(--color-text-muted)]">
              No agent CLI found on this machine. Install one and reopen this panel:
            </p>
            {harnesses.map((h) => (
              <div key={h.harness} className="text-xs">
                <span className="text-[var(--color-text-secondary)]">{h.label}</span>
                <code className="mt-0.5 block rounded bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-primary)]">
                  {h.installHint}
                </code>
              </div>
            ))}
          </div>
        )
        : (
          installed.map((h, i) => (
            <button
              key={h.harness}
              ref={i === 0 ? firstButtonRef : undefined}
              type="button"
              disabled={starting !== null}
              aria-busy={starting === h.harness}
              onClick={() => onStart(h.harness as Harness)}
              className="rounded bg-brand-600 px-3 py-2 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {starting === h.harness ? `Starting ${h.label}…` : `Start ${h.label}`}
              {h.version && <span className="ml-1 font-normal opacity-80">({h.version})</span>}
            </button>
          ))
        )}
    </div>
  );
}
