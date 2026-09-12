import { describe, expect, it } from "vitest";
import type { EditorTab } from "../../types";
import {
  connectionIdOf,
  editorAnswer,
  profileIdOf,
  proposalRefusal,
  proposalTarget,
  resultAnswer,
} from "../agent-requests";
import type { ConnectionInfo, QueryResult } from "../bindings";

const connections = [
  { id: "live-1", profile_id: "p1", name: "shop" },
  { id: "live-2", profile_id: "p2", name: "payroll" },
] as ConnectionInfo[];

const queryTab: EditorTab = {
  id: "t1",
  title: "Untitled Query",
  content: "SELECT * FROM orders",
  isDirty: false,
  type: "query",
  connectionId: "live-1",
  database: "shop",
};

const structureTab: EditorTab = {
  id: "t2",
  title: "⊞ orders",
  content: "",
  isDirty: false,
  type: "structure",
  connectionId: "live-1",
  database: "shop",
  tableName: "orders",
};

describe("connection ids", () => {
  it("translates a live connection to the profile an agent knows", () => {
    // An agent's ids have to survive a restart; the app's do not.
    expect(profileIdOf(connections, "live-1")).toBe("p1");
  });

  it("translates back for a draft an agent asked to open", () => {
    expect(connectionIdOf(connections, "p2")).toBe("live-2");
  });

  it("has no answer for a profile that is not connected", () => {
    expect(connectionIdOf(connections, "p9")).toBeUndefined();
    expect(profileIdOf(connections, undefined)).toBeUndefined();
  });
});

describe("editorAnswer", () => {
  it("reports the tab, its statement and where it would run", () => {
    const answer = editorAnswer([queryTab], "t1", connections, undefined);
    expect(answer).toEqual({
      tab: "t1",
      title: "Untitled Query",
      connection: "p1",
      database: "shop",
      sql: "SELECT * FROM orders",
      selection: undefined,
    });
  });

  it("includes a selection, because that is usually what 'this query' means", () => {
    const answer = editorAnswer([queryTab], "t1", connections, "FROM orders");
    expect(answer?.selection).toBe("FROM orders");
  });

  it("treats an empty selection as none", () => {
    // Sending "" would read as "the user selected nothing on purpose".
    expect(editorAnswer([queryTab], "t1", connections, "   ")?.selection).toBeUndefined();
  });

  it("has no answer for a tab that is not a query", () => {
    // A structure tab has no statement, and an empty one would have an agent
    // confidently rewriting nothing.
    expect(editorAnswer([structureTab], "t2", connections, undefined)).toBeNull();
  });

  it("has no answer when there is no active tab", () => {
    expect(editorAnswer([queryTab], null, connections, undefined)).toBeNull();
  });

  it("reports a tab with no connection rather than refusing", () => {
    // Drafting SQL before picking a server is ordinary.
    const loose = { ...queryTab, connectionId: undefined, database: undefined };
    const answer = editorAnswer([loose], "t1", connections, undefined);
    expect(answer?.connection).toBeUndefined();
    expect(answer?.sql).toBe("SELECT * FROM orders");
  });
});

const result = {
  query_id: "q",
  statement_index: 0,
  sql: "SELECT id, blob FROM orders",
  columns: [
    { name: "id", data_type: "int", nullable: false, is_primary_key: true },
    { name: "blob", data_type: "blob", nullable: true, is_primary_key: false },
  ],
  rows: [[1, [1, 2, 3]], [2, null]],
  rows_affected: 0,
  execution_time_ms: 7,
  warnings: [],
  rows_truncated: true,
} as unknown as QueryResult;

describe("resultAnswer", () => {
  it("reports what ran, its shape and its timing", () => {
    const answer = resultAnswer([result], 0, "live-1", connections);
    expect(answer?.sql).toBe("SELECT id, blob FROM orders");
    expect(answer?.columns).toEqual(["id", "blob"]);
    expect(answer?.rowCount).toBe(2);
    expect(answer?.executionTimeMs).toBe(7);
    expect(answer?.truncated).toBe(true);
  });

  it("carries the connection, so a posture can be applied to the rows", () => {
    // Without it the policy has nothing to look up, and the rows would either
    // leak or be withheld from every connection alike.
    expect(resultAnswer([result], 0, "live-1", connections)?.connection).toBe("p1");
  });

  it("sends rows and leaves the policy to decide about them", () => {
    // Deliberately not filtered here: one rule, in one place.
    expect(resultAnswer([result], 0, "live-1", connections)?.rows[0][0]).toBe(1);
  });

  it("reports binary as its size rather than as a list of bytes", () => {
    // A 2 MB BLOB as a JSON array of numbers is unreadable and enormous.
    expect(resultAnswer([result], 0, "live-1", connections)?.rows[0][1]).toBe("<3 bytes>");
  });

  it("keeps null as null", () => {
    // `WHERE x = 'NULL'` is the bug this prevents.
    expect(resultAnswer([result], 0, "live-1", connections)?.rows[1][1]).toBeNull();
  });

  it("has no answer when nothing has been run", () => {
    expect(resultAnswer([], 0, "live-1", connections)).toBeNull();
  });

  it("answers about the result the user is looking at", () => {
    const second = { ...result, sql: "SELECT 2" } as QueryResult;
    expect(resultAnswer([result, second], 1, "live-1", connections)?.sql).toBe("SELECT 2");
  });
});

describe("proposalTarget", () => {
  it("uses the tab the agent named", () => {
    const other = { ...queryTab, id: "t3" };
    expect(proposalTarget([queryTab, other], "t3", "t1")?.id).toBe("t1");
  });

  it("falls back to the active tab when none was named", () => {
    expect(proposalTarget([queryTab], "t1", null)?.id).toBe("t1");
  });

  it("refuses a tab that has been closed", () => {
    // Writing into whatever is active instead would be the worst possible
    // recovery from a stale id.
    expect(proposalTarget([queryTab], "t1", "gone")).toBeNull();
  });

  it("refuses a tab that cannot hold SQL", () => {
    expect(proposalTarget([structureTab], "t2", "t2")).toBeNull();
  });

  it("refuses when there is no query tab at all", () => {
    expect(proposalTarget([structureTab], "t2", null)).toBeNull();
  });
});

describe("proposalRefusal", () => {
  it("tells an agent with a stale id how to get a fresh one", () => {
    const message = proposalRefusal("gone");
    expect(message).toContain("gone");
    expect(message).toContain("get_editor_context");
  });

  it("points at open_draft when there is no tab to change", () => {
    expect(proposalRefusal(null)).toContain("open_draft");
  });
});
