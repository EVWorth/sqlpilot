import { Database } from "lucide-react";
import { useEffect } from "react";
import { useAgentStore } from "../../stores/agentStore";
import { useDialogStore } from "../../stores/dialogStore";
import { EnvironmentBadge, PostureBadge } from "./AgentBadges";

/**
 * What the agent can reach, under the panel's header.
 *
 * AI_INTEGRATION §5: the posture is shown in the session header, always
 * visible. Someone typing a question into an agent should not have to open a
 * settings dialog to find out whether it can see production rows. "Manage…"
 * goes to that dialog, which otherwise opens only from Tools → Agents….
 */
export function AgentSharingStrip() {
  const connections = useAgentStore((s) => s.connections);
  const refresh = useAgentStore((s) => s.refresh);
  const openDialog = useDialogStore((s) => s.openDialog);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shared = connections.filter((c) => c.posture);

  return (
    <div
      aria-label="What the agent can reach"
      role="group"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-3 py-1.5"
    >
      {shared.length === 0
        ? <span className="text-[11px] text-[var(--color-text-muted)]">No connections shared with agents.</span>
        : shared.map((c) => (
          <span key={c.connectionId} className="flex min-w-0 items-center gap-1">
            <Database className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
            <span className="truncate text-[11px] text-[var(--color-text-primary)]">{c.name}</span>
            <EnvironmentBadge environment={c.environment} />
            {c.posture && <PostureBadge posture={c.posture} />}
          </span>
        ))}
      <button
        type="button"
        onClick={() => openDialog("agents")}
        className="ml-auto rounded px-1 text-[11px] text-brand-400 hover:underline"
      >
        Manage…
      </button>
    </div>
  );
}
