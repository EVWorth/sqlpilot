import { Channel } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../../../package.json";
import type { StartupProblem } from "../../../lib/bindings";
import { UPDATE_VERSION } from "../handlers/plugins";
import { optionsFromUrl } from "../state";
import { call, install, rejection, settle } from "./helpers";

interface DownloadEvent {
  event: "Started" | "Progress" | "Finished";
  data?: { contentLength?: number; chunkLength?: number };
}

async function download(): Promise<{ events: DownloadEvent[]; outcome: Promise<unknown> }> {
  const events: DownloadEvent[] = [];
  const channel = new Channel<DownloadEvent>((e) => events.push(e));
  const outcome = call("plugin:updater|download_and_install", { onEvent: channel, rid: 1 });
  return { events, outcome };
}

describe("app state switches", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defaults to a healthy app with nothing to update", async () => {
    expect(optionsFromUrl("?mock")).toMatchObject({ update: "none", keyring: true, startupProblems: false });
    install("?mock");
    vi.useFakeTimers();
    expect(await settle(call("plugin:updater|check"))).toBeNull();
    expect(await call("keyring_available")).toBe(true);
    expect(await call("startup_problems")).toEqual([]);
  });

  it("reports package.json's version as the running app's", async () => {
    install("?mock=connected&update=available");
    vi.useFakeTimers();
    expect(await call("plugin:app|version")).toBe(packageJson.version);
    expect(await settle(call("plugin:updater|check"))).toMatchObject({ currentVersion: packageJson.version });
  });

  it("keyring=missing reports no credential store", async () => {
    install("?mock&keyring=missing");
    expect(await call("keyring_available")).toBe(false);
  });

  it("startup=problems reports the stores that could not be opened", async () => {
    install("?mock&startup=problems");
    const problems = await call<StartupProblem[]>("startup_problems");
    expect(problems.map((p) => p.kind)).toEqual(["connection-store", "history-store"]);
    for (const p of problems) {
      expect(p.summary.length).toBeLessThanOrEqual(70);
      expect(p.detail).not.toMatch(/\/home\//);
    }
  });

  it("update=available offers a release that downloads to the end", async () => {
    install("?mock&update=available");
    vi.useFakeTimers();
    expect(await settle(call("plugin:updater|check"))).toMatchObject({ version: UPDATE_VERSION, rid: 1 });

    const { events, outcome } = await download();
    expect(await settle(outcome)).toBeNull();
    expect(events[0]).toEqual({ event: "Started", data: { contentLength: 18_400_000 } });
    expect(events.at(-1)).toEqual({ event: "Finished" });
    const total = events.reduce((sum, e) => sum + (e.data?.chunkLength ?? 0), 0);
    expect(total).toBe(18_400_000);
  });

  it("update=downloading keeps the download going for minutes", async () => {
    install("?mock&update=downloading");
    vi.useFakeTimers();
    const { events, outcome } = await download();
    let done = false;
    void outcome.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.length).toBeGreaterThan(1);
    expect(done).toBe(false);
    await settle(outcome, 200_000);
    expect(done).toBe(true);
  });

  it("update=download-error breaks the download halfway", async () => {
    install("?mock&update=download-error");
    vi.useFakeTimers();
    const { events, outcome } = await download();
    const error = await settle(outcome.then(() => "succeeded", (e: unknown) => e));
    expect(error).toMatch(/^error sending request for url/);
    expect(events.some((e) => e.event === "Finished")).toBe(false);
  });

  it("update=error fails the check", async () => {
    install("?mock&update=error");
    vi.useFakeTimers();
    expect(await settle(rejection("plugin:updater|check"))).toBe(
      "Could not fetch a valid release JSON from the remote",
    );
  });
});
