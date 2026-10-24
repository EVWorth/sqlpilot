import { RotateCcw, Send, Square } from "lucide-react";
import { type Ref, useState } from "react";

/**
 * The box the user types into, and the one button beside it that fits the
 * moment: Send, Stop while a turn runs, or a new session once the harness has
 * failed and nothing sent to it would get an answer.
 */
export interface AgentComposerProps {
  thinking: boolean;
  failed: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  onNewSession: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}

export function AgentComposer({ thinking, failed, onSend, onCancel, onNewSession, inputRef }: AgentComposerProps) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (!draft.trim() || thinking || failed) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <div className="border-t border-[var(--color-border)] p-2">
      <textarea
        ref={inputRef}
        aria-label="Message the agent"
        value={draft}
        disabled={failed}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter breaks the line: the convention
          // every chat surface has, including the harnesses' own.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={3}
        placeholder={failed ? "This session has ended." : "Ask about this query…"}
        className="w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] disabled:opacity-60"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          Writes are always approved in this window.
        </span>
        {failed
          ? (
            <button
              type="button"
              onClick={onNewSession}
              className="flex shrink-0 items-center gap-1 rounded bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700"
            >
              <RotateCcw className="h-3 w-3" />
              Start a new session
            </button>
          )
          : thinking
          ? (
            <button
              type="button"
              onClick={onCancel}
              className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          )
          : (
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              className="flex shrink-0 items-center gap-1 rounded bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700 disabled:opacity-50"
            >
              <Send className="h-3 w-3" />
              Send
            </button>
          )}
      </div>
    </div>
  );
}
