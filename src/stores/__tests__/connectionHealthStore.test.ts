import { beforeEach, describe, expect, it, vi } from "vitest";

const { listenFn, apiMocks } = vi.hoisted(() => ({
  listenFn: vi.fn(),
  apiMocks: { poolStats: vi.fn(), pingConnection: vi.fn() },
}));

vi.mock("../../lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  events: { connectionHealthEvent: { listen: listenFn } },
}));

vi.mock("../../lib/tauri-api", () => ({ api: apiMocks }));

import { useConnectionHealthStore } from "../connectionHealthStore";

const healthy = {
  connectionId: "c1",
  healthy: true,
  latencyMs: 3,
  error: null,
  consecutiveFailures: 0,
};

const lost = {
  connectionId: "c1",
  healthy: false,
  latencyMs: null,
  error: "connection refused",
  consecutiveFailures: 2,
};

describe("connectionHealthStore (#276)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    useConnectionHealthStore.setState({ health: {}, pools: {} });
    apiMocks.poolStats.mockResolvedValue([]);
    listenFn.mockResolvedValue(() => {});
  });

  it("records what the backend reports", async () => {
    let emit: ((e: { payload: typeof healthy }) => void) | undefined;
    listenFn.mockImplementation((cb: (e: { payload: typeof healthy }) => void) => {
      emit = cb;
      return Promise.resolve(() => {});
    });

    const stop = await useConnectionHealthStore.getState().start();
    emit!({ payload: lost });

    expect(useConnectionHealthStore.getState().health.c1.healthy).toBe(false);
    expect(useConnectionHealthStore.getState().health.c1.consecutiveFailures).toBe(2);
    stop();
  });

  it("keeps one connection's state out of another's", async () => {
    let emit: ((e: { payload: typeof healthy }) => void) | undefined;
    listenFn.mockImplementation((cb: (e: { payload: typeof healthy }) => void) => {
      emit = cb;
      return Promise.resolve(() => {});
    });

    const stop = await useConnectionHealthStore.getState().start();
    emit!({ payload: lost });
    emit!({ payload: { ...healthy, connectionId: "c2" } });

    const { health } = useConnectionHealthStore.getState();
    expect(health.c1.healthy).toBe(false);
    expect(health.c2.healthy).toBe(true);
    stop();
  });

  it("polls the pool numbers and stops when told to", async () => {
    apiMocks.poolStats.mockResolvedValue([
      { connectionId: "c1", size: 3, idle: 1, max: 5 },
    ]);

    const stop = await useConnectionHealthStore.getState().start();
    await vi.waitFor(() => {
      expect(useConnectionHealthStore.getState().pools.c1.max).toBe(5);
    });

    stop();
    const callsAfterStop = apiMocks.poolStats.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(apiMocks.poolStats.mock.calls.length).toBe(callsAfterStop);
  });

  it("carries on when the event subscription cannot be made", async () => {
    // No live updates is not a reason to leave the app broken: the pool
    // numbers still move and a query still reports its own failure.
    listenFn.mockRejectedValue(new Error("no tauri here"));
    apiMocks.poolStats.mockResolvedValue([
      { connectionId: "c1", size: 1, idle: 1, max: 5 },
    ]);

    const stop = await useConnectionHealthStore.getState().start();
    await vi.waitFor(() => {
      expect(useConnectionHealthStore.getState().pools.c1).toBeDefined();
    });
    stop();
  });

  it("survives a pool read that fails", async () => {
    apiMocks.poolStats.mockRejectedValue(new Error("gone"));
    const stop = await useConnectionHealthStore.getState().start();
    expect(useConnectionHealthStore.getState().pools).toEqual({});
    stop();
  });

  describe("checking on demand", () => {
    it("records the answer", async () => {
      apiMocks.pingConnection.mockResolvedValue(healthy);
      await useConnectionHealthStore.getState().refresh("c1");
      expect(useConnectionHealthStore.getState().health.c1.latencyMs).toBe(3);
    });

    it("treats a failed check as the news it is", async () => {
      // An id the backend no longer knows is the same thing as a connection
      // that cannot answer.
      apiMocks.pingConnection.mockRejectedValue(new Error("Connection not found"));
      await useConnectionHealthStore.getState().refresh("c1");

      const state = useConnectionHealthStore.getState().health.c1;
      expect(state.healthy).toBe(false);
      expect(state.error).toContain("Connection not found");
    });
  });

  it("forgets a connection that has been disconnected", () => {
    useConnectionHealthStore.setState({
      health: { c1: healthy, c2: healthy },
      pools: { c1: { connectionId: "c1", size: 1, idle: 1, max: 5 } },
    });

    useConnectionHealthStore.getState().forget("c1");

    const state = useConnectionHealthStore.getState();
    expect(state.health.c1).toBeUndefined();
    expect(state.pools.c1).toBeUndefined();
    // A later connection could otherwise inherit a dead one's state.
    expect(state.health.c2).toBeDefined();
  });
});
