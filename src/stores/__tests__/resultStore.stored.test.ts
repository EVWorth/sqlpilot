import { install } from "@/dev/mock/__tests__/helpers";
import type { ColumnMeta, ResultHandle_Serialize } from "@/lib/bindings";
import { rowSourceFor } from "@/lib/row-source";
import { api, CommandError } from "@/lib/tauri-api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useEditorStore } from "@/stores/editorStore";
import { useResultStore } from "@/stores/resultStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ConnectionInfo } from "@/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Editor runs that keep their rows in the backend's result store
 * (docs/design/RESULT_STORE.md): what reaches the result state, and when the
 * stored rows are freed.
 */

const COLUMNS: ColumnMeta[] = [{ name: "id", data_type: "INT", nullable: false, is_primary_key: true }];

let handles = 0;
function handle(rowCount: number, extra: Partial<ResultHandle_Serialize> = {}): ResultHandle_Serialize {
  handles += 1;
  return {
    result_id: `r${handles}`,
    statement_index: 0,
    sql: "SELECT id FROM t",
    columns: COLUMNS,
    row_count: rowCount,
    rows_affected: rowCount,
    execution_time_ms: 4,
    warnings: [],
    ...extra,
  };
}

const CONN = "conn-1";

let runQuery: ReturnType<typeof vi.spyOn>;
let executeQuery: ReturnType<typeof vi.spyOn>;
let release: ReturnType<typeof vi.spyOn>;

/** Store ids freed so far. */
const released = () => release.mock.calls.flatMap(([ids]) => ids as string[]);

/** `on`: the store, the default; off: the old path, through the opt-out. */
function useStoreSetting(on: boolean) {
  const { querySettings } = useSettingsStore.getState();
  useSettingsStore.setState({ querySettings: { ...querySettings, keepResultsInWebview: !on } });
}

const run = (sql = "SELECT id FROM t", tab = "tab-1") =>
  useResultStore.getState().executeQuery(CONN, sql, "app", tab, undefined, { fromEditor: true });

beforeEach(() => {
  install();
  handles = 0;
  useConnectionStore.setState({
    activeConnections: [{ id: CONN, name: "Local dev", database: "app" } as unknown as ConnectionInfo],
    profiles: [],
  });
  const tab = { id: "tab-1", title: "Query", content: "", type: "query" as const, isDirty: false };
  useEditorStore.setState({ tabs: [tab], activeTabId: "tab-1" });
  useResultStore.getState().showTab("tab-1");
  useStoreSetting(true);
  runQuery = vi.spyOn(api, "runQuery").mockImplementation(async () => [handle(3)]);
  executeQuery = vi.spyOn(api, "executeQuery").mockResolvedValue([]);
  release = vi.spyOn(api, "resultRelease").mockResolvedValue(undefined);
});

afterEach(() => {
  useResultStore.setState({ results: [], parked: {} });
  vi.restoreAllMocks();
});

describe("running into the result store", () => {
  it("runs through run_query by default, and shows a result without rows", async () => {
    await run();
    expect(runQuery).toHaveBeenCalledWith(CONN, "SELECT id FROM t", "app", 1000, undefined, "tab-1");
    expect(executeQuery).not.toHaveBeenCalled();
    const [result] = useResultStore.getState().results;
    expect(result.rows).toEqual([]);
    expect(result.stored).toEqual({ result_id: "r1", row_count: 3 });
    expect(rowSourceFor(result).rowCount).toBe(3);
  });

  it("takes the old path when the user opts out", async () => {
    useStoreSetting(false);
    await run();
    expect(executeQuery).toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("keeps the old path for runs that are not the editor's", async () => {
    await useResultStore.getState().executeQuery(CONN, "SELECT 1", "app", "tab-1");
    expect(executeQuery).toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("offers a next page when a stored result filled the row limit, and pages into the store", async () => {
    runQuery.mockImplementation(async () => [handle(1000)]);
    await run();
    expect(useResultStore.getState().page).toMatchObject({ index: 0, size: 1000, hasMore: true, stored: true });

    await useResultStore.getState().goToPage(1);
    expect(runQuery).toHaveBeenLastCalledWith(CONN, "SELECT id FROM t", "app", 1000, 1000, "tab-1");
    // The first page's rows are no longer shown, so they are freed.
    expect(released()).toContain("r1");
  });

  it("carries the store's truncation reason to the result", async () => {
    runQuery.mockImplementation(async () => [handle(10, { truncation_reason: "store_full" })]);
    await run();
    const [result] = useResultStore.getState().results;
    expect(result.truncation_reason).toBe("store_full");
    expect(result.rows_truncated).toBe(true);
  });

  it("shows the statements that completed before a failure, from their handles", async () => {
    runQuery.mockRejectedValue(
      new CommandError("Table 'app.nope' doesn't exist", {
        statementIndex: 1,
        completedHandles: [handle(2)],
      }),
    );
    await run("SELECT id FROM t; SELECT * FROM nope");
    const { results, error } = useResultStore.getState();
    expect(error).toContain("nope");
    expect(results).toHaveLength(1);
    expect(results[0].stored).toEqual({ result_id: "r1", row_count: 2 });
  });
});

describe("freeing stored results", () => {
  it("frees a tab's results when it runs again", async () => {
    await run();
    expect(released()).toEqual([]);
    await run();
    expect(released()).toEqual(["r1"]);
  });

  it("frees a closed tab's results, and keeps a parked tab's", async () => {
    await run();
    useEditorStore.setState({
      tabs: [
        ...useEditorStore.getState().tabs,
        { id: "tab-2", title: "Other", content: "", type: "query", isDirty: false },
      ],
    });
    // Parked, not closed: tab-1's result is kept while tab-2 is shown.
    useResultStore.getState().showTab("tab-2");
    expect(released()).toEqual([]);

    useResultStore.getState().forgetTabs(["tab-2"]);
    expect(released()).toEqual(["r1"]);
  });

  it("frees the results read on a connection when it closes", async () => {
    await run();
    useResultStore.getState().forgetConnection(CONN);
    expect(useResultStore.getState().results).toEqual([]);
    expect(released()).toEqual(["r1"]);
  });

  it("leaves results held whole in the webview on screen when their connection closes", async () => {
    useStoreSetting(false);
    executeQuery.mockResolvedValue([
      {
        query_id: "q",
        statement_index: 0,
        sql: "SELECT 1",
        columns: COLUMNS,
        rows: [[1]],
        rows_affected: 1,
        execution_time_ms: 1,
        warnings: [],
        rows_truncated: false,
      },
    ]);
    await run();
    useResultStore.getState().forgetConnection(CONN);
    expect(useResultStore.getState().results).toHaveLength(1);
  });

  it("frees what a failed run completed when nothing will show it", async () => {
    // Started under a tab the editor no longer has, so the error is not shown.
    runQuery.mockImplementation(async () => {
      useResultStore.getState().forgetTabs([]);
      throw new CommandError("boom", { statementIndex: 1, completedHandles: [handle(2)] });
    });
    useEditorStore.setState({ tabs: [], activeTabId: null });
    await run();
    expect(released()).toContain("r1");
  });

  it("never asks the store to free a result that stored no rows", async () => {
    runQuery.mockImplementation(async () => [handle(0, { sql: "UPDATE t SET id = id" })]);
    await run();
    await run();
    expect(released()).toEqual([]);
  });
});
