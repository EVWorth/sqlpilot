import { describe, expect, it } from "vitest";
import { computeMetrics } from "../AdminPanel";

/** SHOW GLOBAL STATUS rows, as the panel receives them. */
function status(overrides: Record<string, number | string> = {}) {
  const base: Record<string, number | string> = {
    Uptime: 604800, // a week
    Queries: 6048000, // 10/s lifetime average
    Slow_queries: 3,
    Connections: 500,
    Threads_connected: 4,
    Threads_running: 1,
    Threads_cached: 2,
    Innodb_buffer_pool_pages_total: 8192,
    Innodb_buffer_pool_pages_free: 2048,
    Innodb_buffer_pool_reads: 100,
    Innodb_buffer_pool_read_requests: 10000,
    Open_tables: 588,
    Opened_tables: 748,
    Table_open_cache_hits: 1000,
    Table_open_cache_misses: 50,
    ...overrides,
  };
  return Object.entries(base).map(([name, value]) => ({ name, value: String(value) }));
}

function card(vars: ReturnType<typeof status>, label: string, previous?: { queries: number; uptime: number }) {
  const found = computeMetrics(vars, previous).find((m) => m.label.startsWith(label));
  if (!found) throw new Error(`no metric card starting with ${label}`);
  return found;
}

describe("table cache hit rate", () => {
  it("uses the real hit and miss counters", () => {
    // 1000 hits, 50 misses → 95.2%. The old formula divided a current gauge
    // (Open_tables) by a cumulative counter (Opened_tables), which is not a
    // hit rate at all.
    expect(card(status(), "Table Cache").sub).toBe("Hit rate: 95.2%");
  });

  it("is not fooled by a long-running server", () => {
    // The old formula read 588/748 = 78.6% here regardless of cache behaviour,
    // and tends to 0% the longer a server runs.
    const s = status({ Open_tables: 10, Opened_tables: 100000 });
    expect(card(s, "Table Cache").sub).toBe("Hit rate: 95.2%");
  });

  it("is not fooled by a freshly restarted server", () => {
    // Every table open and few opened would have read 100% under the old
    // formula, whatever the cache was doing.
    const s = status({
      Open_tables: 50,
      Opened_tables: 50,
      Table_open_cache_hits: 0,
      Table_open_cache_misses: 50,
    });
    expect(card(s, "Table Cache").sub).toBe("Hit rate: 0.0%");
  });

  it("says so when the server does not publish the counters", () => {
    // Better an admitted gap than a confident 100%.
    const s = status({ Table_open_cache_hits: 0, Table_open_cache_misses: 0 });
    expect(card(s, "Table Cache").sub).toContain("unavailable");
  });
});

describe("QPS", () => {
  it("reports the lifetime average, labelled, until there are two readings", () => {
    const c = card(status(), "QPS");
    expect(c.label).toBe("QPS (avg since start)");
    expect(c.value).toBe("10.0");
    expect(c.sub).toContain("after next refresh");
  });

  it("reports the rate over the interval once it has a baseline", () => {
    // 1000 queries in 10 seconds of server uptime → 100 QPS, even though the
    // lifetime average is 10.
    const previous = { queries: 6048000, uptime: 604800 };
    const s = status({ Queries: 6049000, Uptime: 604810 });
    const c = card(s, "QPS", previous);
    expect(c.label).toBe("QPS");
    expect(c.value).toBe("100.0");
  });

  it("reads zero when nothing ran between two readings", () => {
    const previous = { queries: 6048000, uptime: 604800 };
    const s = status({ Queries: 6048000, Uptime: 604830 });
    expect(card(s, "QPS", previous).value).toBe("0.0");
  });

  it("falls back to the lifetime average when uptime went backwards", () => {
    // A restarted server resets Uptime; dividing by a negative interval would
    // produce nonsense.
    const previous = { queries: 9999999, uptime: 999999 };
    const s = status({ Queries: 100, Uptime: 10 });
    expect(card(s, "QPS", previous).label).toBe("QPS (avg since start)");
  });

  it("never reports a negative rate when counters reset", () => {
    const previous = { queries: 9999999, uptime: 604800 };
    const s = status({ Queries: 100, Uptime: 604810 });
    expect(Number(card(s, "QPS", previous).value)).toBeGreaterThanOrEqual(0);
  });
});

describe("buffer pool hit rate", () => {
  it("is left alone — it was already correct", () => {
    // (10000 - 100) / 10000 = 99.00%
    expect(card(status(), "Buffer Pool").sub).toBe("Hit rate: 99.00%");
  });
});
