import { Bot, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAgentSessionStore } from "../../stores/agentSessionStore";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { AgentComposer } from "./AgentComposer";
import { AgentSharingStrip } from "./AgentSharingStrip";
import { AgentStart } from "./AgentStart";
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
    failed,
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

  const bottom = useRef<HTMLDivElement>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  useEffect(() => {
    void findHarnesses();
  }, [findHarnesses]);

  // Follow the conversation as it arrives. Without this the panel shows the
  // top of a long answer while the rest scrolls past unseen.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [transcript]);

  // Ending mid-turn throws away whatever the agent is doing, so it asks
  // first. Between turns there is nothing to lose: the transcript stays.
  const end = () => {
    if (thinking) setConfirmEnd(true);
    else void stop();
  };

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
              onClick={end}
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

      <AgentSharingStrip />

      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}

      {session && !toolsAvailable && (
        <p className="border-b border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-warning)]">
          This agent could not be given SQLPilot's tools, so it cannot see your databases.
        </p>
      )}

      {(session || transcript.length > 0) && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {session && transcript.length === 0 && (
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
      )}

      {session
        ? (
          <AgentComposer
            thinking={thinking}
            failed={failed}
            onSend={(text) => void send(text)}
            onCancel={() => void cancel()}
            onNewSession={() => void stop()}
          />
        )
        : (
          <AgentStart
            harnesses={harnesses}
            starting={starting}
            onStart={(harness) => void start(harness)}
            compact={transcript.length > 0}
          />
        )}

      <ConfirmDialog
        isOpen={confirmEnd}
        title="End the session?"
        message="The agent is still working on this turn. Ending the session stops it; the transcript stays until you start a new one."
        confirmLabel="End session"
        cancelLabel="Keep working"
        danger
        onConfirm={() => {
          setConfirmEnd(false);
          void stop();
        }}
        onCancel={() => setConfirmEnd(false)}
      />
    </div>
  );
}
