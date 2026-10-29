import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestoreSummary } from "../../../lib/bindings";
import { call, install, settle } from "./helpers";

async function restore(profileId: string, stopOnError: boolean): Promise<RestoreSummary> {
  const conn = await settle(call<{ id: string }>("connect", { profileId }));
  return settle(call<RestoreSummary>("restore_database", {
    connectionId: conn.id,
    restoreId: `r-${profileId}-${String(stopOnError)}`,
    inputPath: "/tmp/sqlpilot-mock/shop_backup.sql",
    options: { stopOnError, disableForeignKeyChecks: true, wrapInTransaction: true },
  }));
}

describe("mock restore", () => {
  beforeEach(() => {
    install();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not call a restore that ran nothing partially applied", async () => {
    // Read-only production refuses every statement; with Stop on error off
    // the run goes on to the end without a single success.
    const summary = await restore("profile-prod", false);
    expect(summary.statementsRun).toBe(0);
    expect(summary.statementsFailed).toBeGreaterThan(1);
    expect(summary.partiallyApplied).toBe(false);
  });

  it("rolls back on the first refusal with Stop on error on", async () => {
    const summary = await restore("profile-prod", true);
    expect(summary.statementsFailed).toBe(1);
    expect(summary.rolledBack).toBe(true);
    expect(summary.partiallyApplied).toBe(false);
  });

  it("restores everything on a writable server", async () => {
    const summary = await restore("profile-local", true);
    expect(summary.statementsRun).toBeGreaterThan(0);
    expect(summary.statementsFailed).toBe(0);
    expect(summary.partiallyApplied).toBe(false);
  });
});
