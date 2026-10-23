import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGridEdits, runStatement } from "../../lib/run-statement";
import type { ResultSource } from "../../stores/resultStore";
import type { QueryResult } from "../../types";
import { useGridSave } from "../useGridSave";

// Grid edits are saved where their result was read: the editor tab's own
// session, inside its transaction when one is open (#735).

let resultSource: ResultSource | null = null;
const executeQuery = vi.fn();

vi.mock("../../stores/resultStore", () => ({
  useResultStore: { getState: () => ({ resultSource, executeQuery }) },
}));

vi.mock("../../stores/editorStore", () => ({
  useEditorStore: {
    getState: () => ({
      activeTabId: "tab-1",
      // Moved on since the result was read: another statement, another
      // connection. A save must follow the result, not the editor (#840).
      tabs: [{ id: "tab-1", content: "SELECT * FROM customers", connectionId: "conn-9" }],
    }),
  },
}));

vi.mock("../../stores/connectionStore", () => ({
  useConnectionStore: { getState: () => ({ selectedConnectionId: "conn-1" }) },
}));

vi.mock("../../stores/productionGuardStore", () => ({
  confirmDestructive: vi.fn(async () => true),
}));

vi.mock("../../lib/run-statement", () => ({
  runGridEdits: vi.fn(),
  runStatement: vi.fn(),
}));

const result = {
  columns: [{ name: "id" }, { name: "name" }],
  rows: [[1, "ada"]],
  sql: "SELECT * FROM users",
} as unknown as QueryResult;

function renderSave(onMessage = vi.fn()) {
  const editing = {
    updates: new Map([[0, [{ column: "name", oldValue: "ada", newValue: "grace" }]]]),
    inserts: [],
    deletes: new Set<number>(),
    discardAll: vi.fn(),
  };
  const { result: hook } = renderHook(() =>
    useGridSave({
      result,
      editing: editing as never,
      rowKey: {
        state: { status: "ready", table: "users", columns: ["id"], source: "primary" },
        columns: ["id"],
      } as never,
      keyWarning: null,
      columnTypes: {},
      onMessage,
    })
  );
  return { save: () => act(() => hook.current.save()), onMessage };
}

beforeEach(() => {
  vi.mocked(runGridEdits).mockReset();
  vi.mocked(runStatement).mockReset();
  executeQuery.mockReset();
});

describe("useGridSave", () => {
  it("saves on the tab's session and re-reads the result from there", async () => {
    resultSource = { connectionId: "conn-1", database: "app", session: "tab-1" };
    vi.mocked(runGridEdits).mockResolvedValue({ rows_affected: [1], transaction: "none" });
    const { save, onMessage } = renderSave();

    await save();

    expect(runGridEdits).toHaveBeenCalledWith({
      connectionId: "conn-1",
      session: "tab-1",
      database: "app",
      statements: [expect.stringContaining("UPDATE")],
    });
    expect(runStatement).not.toHaveBeenCalled();
    expect(executeQuery).toHaveBeenCalledWith("conn-1", "SELECT * FROM users", "app", "tab-1");
    expect(onMessage).toHaveBeenCalledWith("Applied 1 change(s)");
  });

  it("says the change is waiting on the user's open transaction", async () => {
    resultSource = { connectionId: "conn-1", database: "app", session: "tab-1" };
    vi.mocked(runGridEdits).mockResolvedValue({ rows_affected: [1], transaction: "open" });
    const { save, onMessage } = renderSave();

    await save();

    expect(onMessage).toHaveBeenCalledWith(expect.stringMatching(/inside your open transaction.*COMMIT/));
  });

  it("falls back to the shared pool when the session cannot tell", async () => {
    resultSource = { connectionId: "conn-1", database: "app", session: "tab-1" };
    vi.mocked(runGridEdits).mockResolvedValue(null);
    vi.mocked(runStatement).mockResolvedValue([{ rows_affected: 1 }] as never);
    const { save, onMessage } = renderSave();

    await save();

    const batch = vi.mocked(runStatement).mock.calls[0][0];
    expect(batch.sql).toMatch(/^START TRANSACTION;[\s\S]*COMMIT;$/);
    expect(batch.database).toBe("app");
    expect(onMessage).toHaveBeenCalledWith("Applied 1 change(s)");
  });

  it("uses the shared pool for a result that has no session", async () => {
    resultSource = { connectionId: "conn-1", database: "app" };
    vi.mocked(runStatement).mockResolvedValue([{ rows_affected: 1 }] as never);
    const { save } = renderSave();

    await save();

    expect(runGridEdits).not.toHaveBeenCalled();
    expect(runStatement).toHaveBeenCalledTimes(1);
    expect(executeQuery).toHaveBeenCalledWith("conn-1", "SELECT * FROM users", "app", undefined);
  });

  it("saves where the result was read, not where the editor points now (#840)", async () => {
    resultSource = { connectionId: "conn-2", database: "other", session: "tab-9" };
    vi.mocked(runGridEdits).mockResolvedValue({ rows_affected: [1], transaction: "none" });
    const { save } = renderSave();

    await save();

    const call = vi.mocked(runGridEdits).mock.calls[0][0];
    expect(call.connectionId).toBe("conn-2");
    expect(call.session).toBe("tab-9");
    expect(call.database).toBe("other");
    expect(call.statements[0]).toMatch(/^UPDATE `users` SET `name` = 'grace' WHERE `id` = 1/);
    expect(executeQuery).toHaveBeenCalledWith("conn-2", "SELECT * FROM users", "other", "tab-9");
  });

  it("refuses when it cannot tell where the result came from", async () => {
    resultSource = null;
    const { save, onMessage } = renderSave();

    await save();

    expect(runGridEdits).not.toHaveBeenCalled();
    expect(runStatement).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.stringMatching(/^Cannot save: /));
  });

  it("reports a failed save and does not refresh", async () => {
    resultSource = { connectionId: "conn-1", database: "app", session: "tab-1" };
    vi.mocked(runGridEdits).mockRejectedValue(new Error("Duplicate entry '3' for key 'PRIMARY'"));
    const { save, onMessage } = renderSave();

    await save();

    expect(executeQuery).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.stringMatching(/^Save failed: .*Duplicate entry/));
  });
});
