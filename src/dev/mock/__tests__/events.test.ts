import { emit, listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupOptions, BackupProgressEvent } from "../../../lib/bindings";
import { call, install } from "./helpers";

describe("mock events", () => {
  beforeEach(() => install("?mock=connected"));
  afterEach(() => vi.restoreAllMocks());

  it("stops delivering an event once its listener unlistens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const got: unknown[] = [];
    const stop = await listen("probe", (e) => got.push(e.payload));
    await emit("probe", 1);
    await stop();
    await emit("probe", 2);

    expect(got).toEqual([1]);
    // The mock used to keep the listener and warn on every later emit.
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn about a backup's progress after the dialog stops listening", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const conn = await call<{ id: string }>("connect", { profileId: "profile-local" });
      const options = await call<BackupOptions>("default_backup_options");
      const events: BackupProgressEvent[] = [];
      const stop = await listen<BackupProgressEvent>("backup-progress-event", (e) => events.push(e.payload));

      const done = call("backup_database", {
        connectionId: conn.id,
        backupId: "b1",
        database: "shop",
        tables: ["customers", "orders"],
        options,
        outputPath: "/tmp/sqlpilot-mock/out.sql",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(events.length).toBeGreaterThan(0);
      await stop();
      const seen = events.length;
      await vi.advanceTimersByTimeAsync(10_000);
      await done;

      expect(events.length).toBe(seen);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
