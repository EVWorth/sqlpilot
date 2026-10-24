import { Bot, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Harness } from "../../lib/bindings";
import { useAgentSessionStore } from "../../stores/agentSessionStore";
import { Thinking, TranscriptBlock } from "./AgentTranscript";

/**
 * A session with the user's own agent, inside the app.
 *
 * The point of building this rather than telling people to use a terminal is
 * that the agent is next to the thing it is talking about: it can read the
 * editor, offer a change as a diff, and ask permission in this window. The
 * panel is the surface all of that happens on.
 *
 * Deliberately plain. A transcript, what the agent is doing, and a box to type
 * in — the harness owns everything else, including which model is answering.
 */

export interface AgentPanelProps {
  onClose: () => void;
}

export function AgentPanel({ onClose }: AgentPanelProps) {
  const {
    harnesses,
    session,
    agent,
    toolsAvailable,
    thinking,
    transcript,
    error,
    starting,
  } = useAgentSessionStore();
  const findHarnesses = useAgentSessionStore((s) => s.findHarnesses);
  const start = useAgentSessionStore((s) => s.start);
  const send = useAgentSessionStore((s) => s.send);
  const cancel = useAgentSessionStore((s) => s.cancel);
  const stop = useAgentSessionStore((s) => s.stop);
  const answer = useAgentSessionStore((s) => s.answer);

  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void findHarnesses();
  }, [findHarnesses]);

  // Follow the conversation as it arrives. Without this the panel shows the
  // top of a long answer while the rest scrolls past unseen.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [transcript]);

  const submit = () => {
    if (!draft.trim() || thinking) return;
    void send(draft);
    setDraft("");
  };

  const installed = harnesses.filter((h) => h.installed);

  return (
    <div className="flex h-full w-[380px] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg-primary)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-brand-400" />
          <span className="truncate text-xs font-semibold text-[var(--color-text-primary)]">
            {agent ?? "Agent"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {session && (
            <button
              type="button"
              onClick={() => void stop()}
              className="rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
            >
              End
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the agent panel"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}

      {!session
        ? (
          <div className="flex flex-1 flex-col justify-center gap-3 p-4">
            <p className="text-xs text-[var(--color-text-secondary)]">
              Run your own agent here, with the connections you have shared. SQLPilot never signs in for you and never
              sees your key — it starts the CLI you already have.
            </p>
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
                installed.map((h) => (
                  <button
                    key={h.harness}
                    type="button"
                    disabled={starting !== null}
                    aria-busy={starting === h.harness}
                    onClick={() => void start(h.harness as Harness)}
                    className="rounded bg-brand-600 px-3 py-2 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                  >
                    {starting === h.harness ? `Starting ${h.label}…` : `Start ${h.label}`}
                    {h.version && <span className="ml-1 font-normal opacity-80">({h.version})</span>}
                  </button>
                ))
              )}
          </div>
        )
        : (
          <>
            {!toolsAvailable && (
              <p className="border-b border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-warning)]">
                This agent could not be given SQLPilot's tools, so it cannot see your databases.
              </p>
            )}
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {transcript.length === 0 && (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Ask about a query, a schema, or the error you just hit.
                </p>
              )}
              {transcript.map((item, i) => <TranscriptBlock key={i} item={item} onAnswer={answer} />)}
              {thinking && (
                <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <Thinking />
                  Working
                </div>
              )}
              <div ref={bottom} />
            </div>

            <div className="border-t border-[var(--color-border)] p-2">
              <textarea
                aria-label="Message the agent"
                value={draft}
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
                placeholder="Ask about this query…"
                className="w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
              />
              <div className="mt-1 flex items-center justify-between">
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  Writes are always approved in this window.
                </span>
                {thinking
                  ? (
                    <button
                      type="button"
                      onClick={() => void cancel()}
                      className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
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
                      className="flex items-center gap-1 rounded bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      <Send className="h-3 w-3" />
                      Send
                    </button>
                  )}
              </div>
            </div>
          </>
        )}
    </div>
  );
}
