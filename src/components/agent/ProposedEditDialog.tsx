import { DiffEditor } from "@monaco-editor/react";
import { Check, Sparkles, X } from "lucide-react";
import type { editor } from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { answerProposal } from "../../hooks/useAgentRequests";
import { useAgentStore } from "../../stores/agentStore";
import { useEditorStore } from "../../stores/editorStore";
import { useThemeStore } from "../../stores/themeStore";

/**
 * A change an agent has offered, as a diff the user answers.
 *
 * The keystone of the whole design: whatever a harness has been told it may do
 * without asking, a change to the user's editor happens here, in SQLPilot's
 * own window, or it does not happen. There is no setting that turns this off.
 *
 * The right-hand side is editable. An agent's answer is often nearly right,
 * and "accept after fixing one thing" is both the most common outcome and the
 * most useful signal to send back — an accepted-but-edited proposal tells the
 * agent its answer was close in a way that a plain rejection does not.
 */

export function ProposedEditDialog() {
  const proposal = useAgentStore((s) => s.proposal);
  const clearProposal = useAgentStore((s) => s.clearProposal);
  const updateTabContent = useEditorStore((s) => s.updateTabContent);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const effectiveTheme = useThemeStore((s) => s.effectiveTheme);

  const diffRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const [sending, setSending] = useState(false);

  // Show the tab being changed, so the diff is never about something the user
  // cannot see.
  useEffect(() => {
    if (proposal) setActiveTab(proposal.tabId);
  }, [proposal, setActiveTab]);

  const decide = useCallback(
    async (accepted: boolean) => {
      if (!proposal || sending) return;
      setSending(true);

      const finalSql = diffRef.current?.getModifiedEditor().getValue() ?? proposal.proposed;
      const edited = accepted && finalSql !== proposal.proposed;

      try {
        if (accepted) updateTabContent(proposal.tabId, finalSql);
        await answerProposal(proposal.id, {
          accepted,
          edited,
          sql: accepted ? finalSql : undefined,
        });
      } finally {
        setSending(false);
        clearProposal();
      }
    },
    [proposal, sending, updateTabContent, clearProposal],
  );

  // Escape rejects rather than dismissing silently: the agent is waiting, and
  // a proposal that vanished without an answer would leave it waiting until
  // its deadline.
  useEffect(() => {
    if (!proposal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void decide(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [proposal, decide]);

  if (!proposal) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative flex h-[70vh] w-[860px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-400" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Suggested change to {proposal.tabTitle}
            </h2>
          </div>
          <button
            onClick={() => void decide(false)}
            aria-label="Reject and close"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-secondary)]">
          {proposal.rationale}
        </p>

        <div className="min-h-0 flex-1">
          <DiffEditor
            original={proposal.current}
            modified={proposal.proposed}
            language="sql"
            theme={effectiveTheme === "dark" ? "vs-dark" : "vs"}
            onMount={(editorInstance) => {
              diffRef.current = editorInstance;
            }}
            options={{
              renderSideBySide: true,
              // Editable, because "accept after fixing one thing" is the most
              // common outcome and worth reporting back as its own answer.
              readOnly: false,
              originalEditable: false,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
            }}
          />
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-3">
          <span className="text-xs text-[var(--color-text-muted)]">
            Nothing is written unless you accept. You can edit the right-hand side first.
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void decide(false)}
              disabled={sending}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => void decide(true)}
              disabled={sending}
              className="flex items-center gap-1 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500"
            >
              <Check className="h-3 w-3" />
              Accept
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
