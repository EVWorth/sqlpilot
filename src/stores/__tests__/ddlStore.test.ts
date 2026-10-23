import { beforeEach, describe, expect, it, vi } from "vitest";

const { getViewDdl } = vi.hoisted(() => ({ getViewDdl: vi.fn() }));

vi.mock("../../lib/tauri-api", () => ({ api: { getViewDdl } }));

import { ddlKey, type DdlTarget, useDdlStore } from "../ddlStore";

const view: DdlTarget = {
  connectionId: "conn-1",
  database: "shop",
  objectName: "order_summary",
  objectType: "VIEW",
};

describe("ddlStore", () => {
  beforeEach(() => {
    useDdlStore.setState({ entries: {} });
    getViewDdl.mockReset();
  });

  it("keeps the DDL it read", async () => {
    getViewDdl.mockResolvedValue("CREATE VIEW order_summary AS SELECT 1");

    await useDdlStore.getState().load(view);

    expect(useDdlStore.getState().entries[ddlKey(view)]).toEqual({
      ddl: "CREATE VIEW order_summary AS SELECT 1",
      loading: false,
      error: null,
    });
  });

  it("reports a failure as the server said it, without an \"Error: \" prefix", async () => {
    // Command rejections are Errors, and String(e) put "Error: " in front of
    // every message (#804).
    getViewDdl.mockRejectedValue(new Error("SHOW VIEW command denied to user"));

    await useDdlStore.getState().load(view);

    expect(useDdlStore.getState().entries[ddlKey(view)]?.error).toBe("SHOW VIEW command denied to user");
  });
});
