/**
 * Turning SHOW GLOBAL STATUS rows into the numbers the panel shows.
 *
 * Separate from the tab that renders them: the arithmetic is the part worth
 * testing, and it was buried in a 793-line file with three unrelated tabs
 * (#432).
 */

/** How often a tab re-reads, in seconds. 0 is manual. */
export type RefreshInterval = 0 | 2 | 5 | 10;

export interface StatusVar {
  name: string;
  value: string;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

export function getStatusVal(vars: StatusVar[], name: string): number {
  const v = vars.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return v ? Number(v.value) || 0 : 0;
}

export interface MetricCard {
  label: string;
  value: string;
  sub?: string;
}

/** A previous SHOW GLOBAL STATUS reading, for the rate calculations. */
export interface StatusSample {
  queries: number;
  uptime: number;
}

export function computeMetrics(vars: StatusVar[], previous?: StatusSample): MetricCard[] {
  const uptime = getStatusVal(vars, "Uptime");
  const queries = getStatusVal(vars, "Queries");
  const slowQueries = getStatusVal(vars, "Slow_queries");
  const connections = getStatusVal(vars, "Connections");
  const threadsConnected = getStatusVal(vars, "Threads_connected");
  const threadsRunning = getStatusVal(vars, "Threads_running");
  const threadsCached = getStatusVal(vars, "Threads_cached");
  const poolSize = getStatusVal(vars, "Innodb_buffer_pool_pages_total");
  const poolFree = getStatusVal(vars, "Innodb_buffer_pool_pages_free");
  const poolReads = getStatusVal(vars, "Innodb_buffer_pool_reads");
  const poolReadRequests = getStatusVal(vars, "Innodb_buffer_pool_read_requests");
  const openTables = getStatusVal(vars, "Open_tables");
  const openedTables = getStatusVal(vars, "Opened_tables");

  const cacheHits = getStatusVal(vars, "Table_open_cache_hits");
  const cacheMisses = getStatusVal(vars, "Table_open_cache_misses");

  // Queries/Uptime is the average since the server started, which on a
  // long-lived server barely moves and tells a DBA nothing about now. The
  // rate over the last interval needs two readings, so the first one still
  // shows the lifetime average — labelled as such rather than as QPS (#443).
  //
  // Uptime is the time base rather than the client clock: it comes from the
  // same reading as the counter, so a slow response or a clock adjustment
  // cannot skew it.
  const elapsed = previous ? uptime - previous.uptime : 0;
  const isLive = previous !== undefined && elapsed > 0;
  const qps = isLive
    ? Math.max(0, (queries - previous.queries) / elapsed).toFixed(1)
    : uptime > 0
    ? (queries / uptime).toFixed(1)
    : "0";
  const poolUsagePct = poolSize > 0 ? (((poolSize - poolFree) / poolSize) * 100).toFixed(1) : "0";
  const poolHitRate = poolReadRequests > 0
    ? (((poolReadRequests - poolReads) / poolReadRequests) * 100).toFixed(2)
    : "100";
  // Open_tables is how many are open right now; Opened_tables is how many
  // have ever been opened. Their ratio is not a hit rate — it reads 0% on a
  // server that has been up a week and 100% on one just restarted, whatever
  // the cache is doing. MySQL 5.6+ and MariaDB both publish the real
  // counters (#431).
  const cacheRequests = cacheHits + cacheMisses;
  const cacheHitRate = cacheRequests > 0
    ? ((cacheHits / cacheRequests) * 100).toFixed(1)
    : null;

  return [
    { label: "Uptime", value: formatUptime(uptime) },
    { label: "Connections", value: String(threadsConnected), sub: `${connections} total` },
    {
      label: isLive ? "QPS" : "QPS (avg since start)",
      value: qps,
      sub: isLive
        ? `${queries.toLocaleString()} total`
        : `${queries.toLocaleString()} total — live rate after next refresh`,
    },
    { label: "Slow Queries", value: slowQueries.toLocaleString() },
    {
      label: "Threads",
      value: `${threadsRunning} running`,
      sub: `${threadsConnected} connected / ${threadsCached} cached`,
    },
    { label: "Buffer Pool Usage", value: `${poolUsagePct}%`, sub: `Hit rate: ${poolHitRate}%` },
    {
      label: "Table Cache",
      value: `${openTables} open`,
      sub: cacheHitRate === null
        ? `${openedTables.toLocaleString()} opened — hit rate unavailable`
        : `Hit rate: ${cacheHitRate}%`,
    },
  ];
}
