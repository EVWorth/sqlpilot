import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleDot, Loader2, X } from "lucide-react";
import { useState } from "react";
import type { TranscriptItem } from "../../lib/agent-transcript";
import { AgentMarkdown, Inline } from "./AgentMarkdown";

/**
 * One block of an agent session's transcript.
 *
 * Split from the panel so the panel is about the session — starting, sending,
 * ending — and this is about how each kind of block reads.
 */

export function Thinking() {
  return <Loader2 className="h-3 w-3 animate-spin text-[var(--color-text-muted)]" />;
}

/** Reasoning, collapsed by default: it is long, and it is not the answer. */
function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-[var(--color-text-muted)]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 hover:text-[var(--color-text-secondary)]"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Reasoning
      </button>
      {open && <p className="mt-1 whitespace-pre-wrap pl-4 italic">{text}</p>}
    </div>
  );
}

/**
 * What the agent ran. The detail is the statement and its outcome; collapsed
 * to a line by default, because a turn can run a dozen of them, and one click
 * from the whole thing, because "what did it actually run" is the question.
 */
function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const detail = item.status !== "running" ? item.detail : undefined;
  return (
    <div className="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
      {item.status === "running"
        ? <Thinking />
        : item.status === "failed"
        ? <X className="h-3 w-3 text-[var(--color-error)]" />
        : <Check className="h-3 w-3 text-[var(--color-success)]" />}
      <div className="min-w-0 flex-1">
        <span className="break-words">{item.title}</span>
        {detail && (
          <>
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Hide what the agent ran" : "Show what the agent ran"}
              title={detail}
              onClick={() => setOpen(!open)}
              className="flex w-full min-w-0 items-start gap-1 text-left text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            >
              {open
                ? <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" />
                : <ChevronRight className="mt-0.5 h-3 w-3 shrink-0" />}
              {!open && <span className="truncate">{detail}</span>}
            </button>
            {open && (
              <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg-tertiary)] p-1.5 font-mono text-[11px] text-[var(--color-text-primary)]">
                {detail}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The harness's own permission prompt, rendered here.
 *
 * This is not SQLPilot's approval — a write to a shared database is approved
 * separately and cannot be granted from here. This is the agent asking to run
 * a command or read a file, and it is in this window rather than in a terminal
 * the user cannot see.
 */
function PermissionRow(
  { item, onAnswer }: {
    item: Extract<TranscriptItem, { kind: "permission" }>;
    onAnswer: (optionId?: string) => void;
  },
) {
  const answered = item.answered !== undefined || item.dismissed;
  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" />
        <span className="break-words text-xs text-[var(--color-text-primary)]">{item.title}</span>
      </div>
      {item.detail && (
        // The whole request, not just its first line: a WHERE clause on the
        // second line is the difference between one row and every row.
        <pre className="mt-1 ml-6 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg-tertiary)] p-1.5 font-mono text-[11px] text-[var(--color-text-primary)]">
          {item.detail}
        </pre>
      )}
      {answered
        ? (
          <p className="mt-1 pl-6 text-xs text-[var(--color-text-muted)]">
            {item.dismissed
              ? "Dismissed."
              : item.options.find((o) => o.id === item.answered)?.label ?? "Answered."}
          </p>
        )
        : (
          <div className="mt-2 flex flex-wrap gap-1 pl-6">
            {item.options.map((option) => (
              // Only the one-off allow is primary; "always" is a bigger
              // commitment and should not look like the default.
              <button
                key={option.id}
                type="button"
                onClick={() => onAnswer(option.id)}
                className={option.kind === "allow_once"
                  ? "rounded bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700"
                  : "rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
    </div>
  );
}

function PlanRow({ item }: { item: Extract<TranscriptItem, { kind: "plan" }> }) {
  return (
    <div className="rounded border border-[var(--color-border)] p-2">
      <p className="mb-1 text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">
        Plan
      </p>
      <ul className="space-y-0.5">
        {item.entries.map((entry, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs">
            {entry.status === "completed"
              ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-[var(--color-success)]" />
              : entry.status === "in_progress"
              ? <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-brand-400" />
              : <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />}
            <span
              className={entry.status === "completed"
                ? "text-[var(--color-text-muted)] line-through"
                : "text-[var(--color-text-secondary)]"}
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TranscriptBlock({ item, onAnswer }: {
  item: TranscriptItem;
  onAnswer: (id: string, optionId?: string) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <p className="whitespace-pre-wrap rounded bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]">
          {item.text}
        </p>
      );
    case "agent":
      return <AgentMarkdown text={item.text} />;
    case "thought":
      return <Thought text={item.text} />;
    case "tool":
      return <ToolRow item={item} />;
    case "permission":
      return <PermissionRow item={item} onAnswer={(option) => onAnswer(item.id, option)} />;
    case "plan":
      return <PlanRow item={item} />;
    case "note":
      return <p className="text-xs italic text-[var(--color-text-muted)]">{item.text}</p>;
    case "error":
      return (
        <div
          role="alert"
          className="flex items-start gap-2 rounded surface-error px-2 py-1.5 text-xs text-[var(--color-error)]"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p className="min-w-0 break-words">
            <Inline text={item.text} />
          </p>
        </div>
      );
  }
}
