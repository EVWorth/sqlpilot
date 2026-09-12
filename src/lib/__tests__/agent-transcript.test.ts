import { describe, expect, it } from "vitest";
import {
  addUserMessage,
  answerPermission,
  applyEvent,
  pendingPermissions,
  type TranscriptItem,
} from "../agent-transcript";
import type { SessionEvent } from "../bindings";

/** Fold a sequence, the way the store does. */
function fold(events: SessionEvent[], from: TranscriptItem[] = []): TranscriptItem[] {
  return events.reduce(applyEvent, from);
}

const text = (delta: string): SessionEvent => ({ type: "text", delta });

describe("text", () => {
  it("joins deltas into one block", () => {
    // One block per token is not a transcript.
    const items = fold([text("The "), text("answer "), text("is 42.")]);
    expect(items).toEqual([{ kind: "agent", text: "The answer is 42." }]);
  });

  it("starts a new block after anything else", () => {
    const items = fold([
      text("first"),
      { type: "toolStarted", id: "t1", title: "Reading", kind: "read" },
      text("second"),
    ]);
    expect(items.filter((i) => i.kind === "agent")).toHaveLength(2);
  });

  it("keeps reasoning apart from the answer", () => {
    const items = fold([
      { type: "thought", delta: "weighing " },
      { type: "thought", delta: "it up" },
      text("pong"),
    ]);
    expect(items).toEqual([
      { kind: "thought", text: "weighing it up" },
      { kind: "agent", text: "pong" },
    ]);
  });
});

describe("tools", () => {
  it("shows what is running", () => {
    const items = fold([{ type: "toolStarted", id: "t1", title: "run_select", kind: "execute" }]);
    expect(items[0]).toEqual({
      kind: "tool",
      id: "t1",
      title: "run_select",
      toolKind: "execute",
      status: "running",
    });
  });

  it("finishes the call that finished, not the last one started", () => {
    // Agents run tools concurrently, and they do not finish in order.
    const items = fold([
      { type: "toolStarted", id: "t1", title: "one", kind: "read" },
      { type: "toolStarted", id: "t2", title: "two", kind: "read" },
      { type: "toolFinished", id: "t1", status: "completed", detail: "3 rows" },
    ]);
    expect(items[0]).toMatchObject({ id: "t1", status: "completed", detail: "3 rows" });
    expect(items[1]).toMatchObject({ id: "t2", status: "running" });
  });

  it("marks a failure as one", () => {
    const items = fold([
      { type: "toolStarted", id: "t1", title: "one", kind: "read" },
      { type: "toolFinished", id: "t1", status: "failed", detail: "no such table" },
    ]);
    expect(items[0]).toMatchObject({ status: "failed", detail: "no such table" });
  });

  it("ignores a result for a call it never saw start", () => {
    // Possible after a reconnect. Inventing a block for it would show a tool
    // call with no title.
    expect(fold([{ type: "toolFinished", id: "ghost", status: "completed" }])).toEqual([]);
  });

  it("keeps the detail it already had when a finish carries none", () => {
    const items = fold([
      { type: "toolStarted", id: "t1", title: "one", kind: "read" },
      { type: "toolFinished", id: "t1", status: "completed", detail: "output" },
      { type: "toolFinished", id: "t1", status: "completed" },
    ]);
    expect(items[0]).toMatchObject({ detail: "output" });
  });
});

describe("plans", () => {
  const plan = (statuses: string[]): SessionEvent => ({
    type: "plan",
    entries: statuses.map((status, i) => ({ content: `step ${i}`, status })),
  });

  it("shows the plan as it stands now", () => {
    // Revised plans replace rather than accumulate: three copies of the same
    // list is noise.
    const items = fold([plan(["pending", "pending"]), plan(["completed", "in_progress"])]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "plan" });
    expect((items[0] as Extract<TranscriptItem, { kind: "plan" }>).entries[0].status).toBe(
      "completed",
    );
  });

  it("keeps the plan where it first appeared", () => {
    // Moving it to the bottom on every revision would make the transcript
    // jump while the user is reading.
    const items = fold([plan(["pending"]), text("working on it"), plan(["completed"])]);
    expect(items[0].kind).toBe("plan");
    expect(items[1].kind).toBe("agent");
  });
});

describe("permissions", () => {
  const request: SessionEvent = {
    type: "permissionRequested",
    id: "p1",
    title: "Run `rm -rf build`",
    detail: "execute",
    options: [
      { id: "yes", label: "Allow once", kind: "allow_once" },
      { id: "no", label: "Reject", kind: "reject_once" },
    ],
  };

  it("waits for an answer", () => {
    const items = fold([request]);
    expect(pendingPermissions(items)).toHaveLength(1);
  });

  it("stops waiting once answered", () => {
    const items = answerPermission(fold([request]), "p1", "yes");
    expect(pendingPermissions(items)).toHaveLength(0);
    expect(items[0]).toMatchObject({ answered: "yes" });
  });

  it("records a dismissal as a dismissal, not as a choice", () => {
    // The protocol distinguishes them: a dismissal tells the agent to stop
    // rather than to look for another way round.
    const items = answerPermission(fold([request]), "p1", undefined);
    expect(items[0]).toMatchObject({ dismissed: true, answered: undefined });
    expect(pendingPermissions(items)).toHaveLength(0);
  });

  it("leaves other requests alone", () => {
    const second = { ...request, id: "p2" } as SessionEvent;
    const items = answerPermission(fold([request, second]), "p1", "yes");
    expect(pendingPermissions(items)).toHaveLength(1);
    expect(pendingPermissions(items)[0].id).toBe("p2");
  });
});

describe("endings", () => {
  it("says nothing about an ordinary one", () => {
    // A line saying "done" after every answer is noise.
    expect(fold([text("hi"), { type: "turnEnded", reason: "end_turn" }])).toHaveLength(1);
  });

  it("says something about an unusual one", () => {
    const items = fold([{ type: "turnEnded", reason: "max_tokens" }]);
    expect(items[0]).toMatchObject({ kind: "note" });
    expect((items[0] as { text: string }).text).toContain("ran out of room");
  });

  it("passes on a reason it does not recognise rather than hiding it", () => {
    const items = fold([{ type: "turnEnded", reason: "something_new" }]);
    expect((items[0] as { text: string }).text).toContain("something_new");
  });

  it("shows a failure as a note in the transcript", () => {
    const items = fold([{ type: "failed", message: "The agent stopped." }]);
    expect(items[0]).toEqual({ kind: "note", text: "The agent stopped." });
  });
});

describe("the user's own messages", () => {
  it("go in before the answer", () => {
    const items = fold([text("hello there")], addUserMessage([], "hi"));
    expect(items).toEqual([
      { kind: "user", text: "hi" },
      { kind: "agent", text: "hello there" },
    ]);
  });
});
