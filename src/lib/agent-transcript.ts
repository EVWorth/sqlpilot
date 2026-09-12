import type { PermissionOption, PlanEntry, SessionEvent } from "./bindings";

/**
 * A session's events, turned into something worth reading.
 *
 * The events are deltas — a character here, a tool status there — and a
 * transcript is a list of blocks. This is the fold between them, kept pure so
 * that "what does the panel show after this sequence" is a unit test rather
 * than something you check by starting an agent and watching.
 *
 * The merging rules are the whole content of this file, and they exist because
 * the naive version produces a transcript with one block per token.
 */

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | {
    kind: "tool";
    id: string;
    title: string;
    toolKind: string;
    status: "running" | "completed" | "failed";
    detail?: string;
  }
  | {
    kind: "permission";
    id: string;
    title: string;
    detail?: string;
    options: PermissionOption[];
    /** The option the user picked, once they have. */
    answered?: string;
    /** True when it was dismissed without a decision. */
    dismissed?: boolean;
  }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "note"; text: string };

/** What the user typed, added before the agent answers it. */
export function addUserMessage(items: TranscriptItem[], text: string): TranscriptItem[] {
  return [...items, { kind: "user", text }];
}

/**
 * Fold one event into the transcript.
 *
 * Returns a new array when something changed and the same one when nothing
 * did, so React can skip a render for events that are not worth one.
 */
export function applyEvent(items: TranscriptItem[], event: SessionEvent): TranscriptItem[] {
  const last = items[items.length - 1];

  switch (event.type) {
    case "text": {
      // Appended to the block in progress rather than added as its own: one
      // block per token is not a transcript, it is a mess.
      if (last?.kind === "agent") {
        return [...items.slice(0, -1), { ...last, text: last.text + event.delta }];
      }
      return [...items, { kind: "agent", text: event.delta }];
    }

    case "thought": {
      if (last?.kind === "thought") {
        return [...items.slice(0, -1), { ...last, text: last.text + event.delta }];
      }
      return [...items, { kind: "thought", text: event.delta }];
    }

    case "toolStarted":
      return [...items, {
        kind: "tool",
        id: event.id,
        title: event.title,
        toolKind: event.kind,
        status: "running",
      }];

    case "toolFinished": {
      // Found by id rather than assumed to be last: an agent runs several
      // tools at once, and they do not finish in the order they started.
      const index = items.findIndex((item) => item.kind === "tool" && item.id === event.id);
      if (index === -1) return items;
      const tool = items[index] as Extract<TranscriptItem, { kind: "tool" }>;
      const updated: TranscriptItem = {
        ...tool,
        status: event.status === "failed" ? "failed" : "completed",
        detail: event.detail ?? tool.detail,
      };
      return [...items.slice(0, index), updated, ...items.slice(index + 1)];
    }

    case "permissionRequested":
      return [...items, {
        kind: "permission",
        id: event.id,
        title: event.title,
        detail: event.detail ?? undefined,
        options: event.options,
      }];

    case "plan": {
      // Replaced rather than appended: a plan that is revised three times
      // should show once, as it stands now.
      const index = items.findIndex((item) => item.kind === "plan");
      const entry: TranscriptItem = { kind: "plan", entries: event.entries };
      if (index === -1) return [...items, entry];
      return [...items.slice(0, index), entry, ...items.slice(index + 1)];
    }

    case "turnEnded":
      // "end_turn" is the ordinary case and needs no line in the transcript.
      // Anything else is worth saying, in the harness's own word.
      return event.reason === "end_turn"
        ? items
        : [...items, { kind: "note", text: endingNote(event.reason) }];

    case "failed":
      return [...items, { kind: "note", text: event.message }];

    case "started":
      return items;
  }
}

/** Mark a permission as answered, so its buttons stop inviting a second click. */
export function answerPermission(
  items: TranscriptItem[],
  id: string,
  option: string | undefined,
): TranscriptItem[] {
  return items.map((item) =>
    item.kind === "permission" && item.id === id
      ? { ...item, answered: option, dismissed: option === undefined }
      : item
  );
}

/** Permission requests still waiting for an answer. */
export function pendingPermissions(items: TranscriptItem[]) {
  return items.filter(
    (item): item is Extract<TranscriptItem, { kind: "permission" }> =>
      item.kind === "permission" && item.answered === undefined && !item.dismissed,
  );
}

/** Why a turn ended, for the cases worth mentioning. */
function endingNote(reason: string): string {
  switch (reason) {
    case "cancelled":
      return "Stopped.";
    case "max_tokens":
      return "The agent ran out of room to answer. Ask it to continue, or ask something narrower.";
    case "max_turn_requests":
      return "The agent hit its limit for tool calls in one turn.";
    case "refusal":
      return "The agent declined to answer.";
    default:
      return `The turn ended: ${reason}.`;
  }
}
