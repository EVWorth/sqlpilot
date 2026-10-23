import { describe, expect, it } from "vitest";
import { runConnectionId } from "../run-connection";

describe("runConnectionId (#788)", () => {
  it("runs on the tab's own connection, not the selected one", () => {
    // The tab is drawn as production; Run must not go to dev.
    expect(runConnectionId({ connectionId: "prod" }, "dev", ["dev", "prod"])).toBe("prod");
  });

  it("falls back to the selected connection for a tab with none", () => {
    expect(runConnectionId({ connectionId: undefined }, "dev", ["dev"])).toBe("dev");
    expect(runConnectionId(undefined, "dev", ["dev"])).toBe("dev");
  });

  it("falls back to the selected connection when the tab's server has gone", () => {
    expect(runConnectionId({ connectionId: "old" }, "dev", ["dev"])).toBe("dev");
  });

  it("has nothing to run on with no tab connection and nothing selected", () => {
    expect(runConnectionId({ connectionId: undefined }, null, [])).toBeUndefined();
  });
});
