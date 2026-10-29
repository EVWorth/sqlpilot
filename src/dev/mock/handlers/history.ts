// Query history: an in-memory stand-in for `history.db`.
//
// Filtering, sorting, paging and the export follow `mas-core/src/history`
// closely, because the panel is a thin view over those queries and a mock
// that filtered differently would review a different panel.
//
// Seed timestamps are minutes before the page loaded, not fixed dates. The
// panel shows them relative ("12m ago"), so anchoring to the load is what
// keeps a screenshot the same from one day to the next.

import type { HistoryEntry, HistoryExportFormat, HistoryFacets, HistoryQuery } from "../../../lib/bindings";
import { rand } from "../dataset";
import { delay, type Handlers } from "../router";

interface Stored extends HistoryEntry {
  /** Insertion order, SQLite's rowid: the tiebreak for equal timestamps. */
  seq: number;
}

type ErrorInfo = [code: number, sqlState: string, message: string];

/** [minutes ago, sql, connection, database, origin, ms, rows, error?] */
type SeedRow = [number, string, string, string | null, string, number, number, ErrorInfo?];

const LOCAL = "Local dev";
const STAGING = "Staging";
const PROD = "Production (read-only)";
const MARIA = "MariaDB sandbox";

const ORDERS_BY_STATUS =
  "SELECT status, COUNT(*) AS n, SUM(total) AS revenue\nFROM orders\nGROUP BY status\nORDER BY n DESC";

const SEED: SeedRow[] = [
  [
    4,
    "SELECT * FROM customers WHERE city = 'Lisbon' ORDER BY created_at DESC LIMIT 100",
    LOCAL,
    "shop",
    "editor",
    18,
    100,
  ],
  [9, ORDERS_BY_STATUS, LOCAL, "shop", "editor", 42, 5],
  [10, ORDERS_BY_STATUS, LOCAL, "shop", "editor", 39, 5],
  [11, ORDERS_BY_STATUS, LOCAL, "shop", "editor", 47, 5],
  [
    16,
    "SELECT o.id, o.total, c.email\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.status = 'pending' AND o.placed_at < NOW() - INTERVAL 7 DAY",
    LOCAL,
    "shop",
    "editor",
    128,
    37,
  ],
  [22, "UPDATE orders SET status = 'shipped' WHERE id IN (8801, 8804, 8812)", LOCAL, "shop", "editor", 9, 3],
  [23, "UPDATE `products` SET `stock` = 118 WHERE `id` = 7", LOCAL, "shop", "grid", 6, 1],
  [31, "SELECT * FROM order_item WHERE order_id = 8812", LOCAL, "shop", "editor", 2, 0, [
    1146,
    "42S02",
    "Table 'shop.order_item' doesn't exist",
  ]],
  [32, "SELECT * FROM order_items WHERE order_id = 8812", LOCAL, "shop", "editor", 3, 4],
  [
    58,
    "SELECT name, COUNT(*) FROM events WHERE occurred_at >= CURDATE() GROUP BY name",
    STAGING,
    "analytics",
    "editor",
    2_840,
    5,
  ],
  [
    64,
    "SELECT user_id, COUNT(*) AS events\nFROM events\nGROUP BY user_id\nORDER BY events DESC\nLIMIT 50",
    STAGING,
    "analytics",
    "editor",
    30_012,
    0,
    [3024, "HY000", "Query execution was interrupted, maximum statement execution time exceeded"],
  ],
  [70, "EXPLAIN FORMAT=TREE SELECT * FROM events WHERE user_id = 4211", STAGING, "analytics", "editor", 11, 1],
  [95, "SELECT COUNT(*) FORM orders WHERE status = 'paid'", PROD, "shop", "editor", 1, 0, [
    1064,
    "42000",
    "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'FORM orders WHERE status = 'paid'' at line 1",
  ]],
  [96, "SELECT COUNT(*) FROM orders WHERE status = 'paid'", PROD, "shop", "editor", 212, 1],
  [
    140,
    "SELECT DATE(placed_at) AS day, SUM(total) AS revenue\nFROM orders\nWHERE placed_at >= CURDATE() - INTERVAL 30 DAY\nGROUP BY day\nORDER BY day",
    PROD,
    "shop",
    "editor",
    1_180,
    30,
  ],
  [180, "ALTER TABLE `customers` ADD INDEX `idx_city` (`city`)", LOCAL, "shop", "designer", 1_942, 0],
  [181, "SHOW INDEX FROM `customers`", LOCAL, "shop", "schema", 4, 4],
  [300, "KILL QUERY 2290", STAGING, null, "admin", 2, 0],
  [302, "SET GLOBAL max_connections = 500", STAGING, null, "admin", 3, 0],
  [600, "CREATE USER 'reporting'@'%' IDENTIFIED BY <redacted>", STAGING, null, "admin", 21, 0],
  [610, "CALL refresh_daily_signups('2026-10-01')", STAGING, "analytics", "routine", 4_310, 31],
  [1_440, "SELECT * FROM `products` LIMIT 200 OFFSET 0", LOCAL, "shop", "grid", 5, 12],
  [1_452, "DELETE FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)", LOCAL, "shop", "editor", 51_204, 0, [
    1205,
    "HY000",
    "Lock wait timeout exceeded; try restarting transaction",
  ]],
  [
    1_460,
    "INSERT INTO products (sku, name, price, stock) VALUES ('SKU-1084', 'Desk lamp', 39.99, 40)",
    LOCAL,
    "shop",
    "editor",
    7,
    1,
  ],
  [1_475, "SELECT id, sku, name, price FROM products WHERE stock < 20 ORDER BY stock", LOCAL, "shop", "editor", 3, 4],
  [
    2_900,
    "INSERT INTO `customers` (`first_name`, `last_name`, `email`, `city`) VALUES\n('Ada', 'Lovelace', 'ada.l@example.com', 'Dublin'),\n('Alan', 'Turing', 'alan.t@example.com', 'Perth')",
    LOCAL,
    "shop",
    "import",
    64,
    2,
  ],
  [2_901, "DROP TABLE IF EXISTS `order_items`", LOCAL, "shop", "restore", 12, 0],
  [3_100, "SELECT VERSION(), @@sql_mode, @@time_zone", MARIA, null, "editor", 1, 1],
  [
    3_104,
    "SELECT JSON_EXTRACT(properties, '$.path') AS path, COUNT(*)\nFROM analytics.events\nGROUP BY path",
    MARIA,
    "analytics",
    "editor",
    9_870,
    4,
  ],
  [
    4_320,
    "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'shop'",
    LOCAL,
    "information_schema",
    "internal",
    6,
    5,
  ],
  [
    5_760,
    "UPDATE customers SET is_active = 0 WHERE created_at < '2025-01-01' AND id NOT IN (SELECT customer_id FROM orders)",
    STAGING,
    "shop",
    "editor",
    2_204,
    118,
  ],
  [5_790, "UPDATE customers SET is_active = 0 WHERE created_at < '2025-01-01'", PROD, "shop", "editor", 2, 0, [
    1290,
    "HY000",
    "The MySQL server is running with the --read-only option so it cannot execute this statement",
  ]],
  [
    8_640,
    "SELECT c.city, COUNT(DISTINCT o.customer_id) AS buyers, ROUND(AVG(o.total), 2) AS avg_order\nFROM orders o JOIN customers c ON c.id = o.customer_id\nGROUP BY c.city\nORDER BY buyers DESC",
    LOCAL,
    "shop",
    "editor",
    355,
    10,
  ],
  [10_080, "SELECT * FROM daily_signups ORDER BY day DESC LIMIT 30", STAGING, "analytics", "editor", 4, 30],
  [
    11_520,
    "CREATE TABLE refunds (\n  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  order_id INT UNSIGNED NOT NULL,\n  amount DECIMAL(10,2) NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n)",
    LOCAL,
    "shop",
    "editor",
    38,
    0,
  ],
  [
    14_400,
    "SELECT source, SUM(signups) FROM daily_signups WHERE day >= '2026-09-01' GROUP BY source",
    STAGING,
    "analytics",
    "editor",
    6,
    3,
  ],
  [18_720, "SELECT * FROM orders WHERE notes->>'$.channel' = 'phone' LIMIT 500", LOCAL, "shop", "editor", 88, 412],
  [20_160, "OPTIMIZE TABLE events", STAGING, "analytics", "admin", 184_300, 1],
  [
    25_920,
    "SELECT p.name, SUM(oi.quantity) AS sold\nFROM order_items oi JOIN products p ON p.id = oi.product_id\nGROUP BY p.name\nORDER BY sold DESC",
    PROD,
    "shop",
    "editor",
    1_420,
    12,
  ],
  [30_240, "SHOW PROCESSLIST", PROD, null, "editor", 2, 14],
];

/**
 * The routine queries of the month before: enough of them that the panel has
 * pages to turn (it loads 50 at a time), all older than the hand-written seed
 * above so the first screen stays the one worth looking at.
 */
const ROUTINE: [sql: string, connection: string, database: string, origin: string][] = [
  ["SELECT * FROM `orders` LIMIT 200 OFFSET 0", LOCAL, "shop", "grid"],
  ["SELECT * FROM `customers` LIMIT 200 OFFSET 0", LOCAL, "shop", "grid"],
  ["SELECT COUNT(*) FROM orders WHERE status = 'pending'", LOCAL, "shop", "editor"],
  ["SELECT id, email FROM customers WHERE is_active = 0 ORDER BY created_at", LOCAL, "shop", "editor"],
  ["UPDATE `products` SET `stock` = `stock` - 1 WHERE `id` = 4", LOCAL, "shop", "grid"],
  [
    "SELECT name, COUNT(*) FROM events WHERE occurred_at >= CURDATE() - INTERVAL 1 DAY GROUP BY name",
    STAGING,
    "analytics",
    "editor",
  ],
  ["SELECT * FROM daily_signups ORDER BY day DESC LIMIT 7", STAGING, "analytics", "editor"],
  ["SHOW CREATE TABLE `orders`", LOCAL, "shop", "schema"],
  ["SELECT status, COUNT(*) FROM orders GROUP BY status", PROD, "shop", "editor"],
  ["EXPLAIN SELECT * FROM orders WHERE customer_id = 812", PROD, "shop", "editor"],
  ["SELECT * FROM order_items WHERE order_id = 7731", LOCAL, "shop", "editor"],
  ["SELECT VERSION()", MARIA, "", "editor"],
];

const ROUTINE_ENTRIES = 90;
const LOCK_WAIT = "Lock wait timeout exceeded; try restarting transaction";

function routineRows(after: number): SeedRow[] {
  return Array.from({ length: ROUTINE_ENTRIES }, (_, i): SeedRow => {
    const [sql, connection, database, origin] = ROUTINE[Math.floor(rand(i, 61) * ROUTINE.length)];
    const ms = 1 + Math.floor(rand(i, 62) ** 3 * 4_000);
    const rows = sql.startsWith("UPDATE") ? 1 : Math.floor(rand(i, 63) * 200);
    // One in fifteen of them failed, the way a lock wait does now and then.
    const failed = rand(i, 64) < 1 / 15;
    const at = after + 120 + i * 137;
    const db = database || null;
    if (!failed) return [at, sql, connection, db, origin, ms, rows];
    return [at, sql, connection, db, origin, 50_001, 0, [1205, "HY000", LOCK_WAIT]];
  });
}

const ALL_SEED: SeedRow[] = [...SEED, ...routineRows(SEED[SEED.length - 1][0])];

function seedEntries(): Stored[] {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  // Oldest first, so `seq` grows with time as rowid does.
  return [...ALL_SEED].reverse().map(([ago, sql, connectionName, database, origin, ms, rows, err], i) => ({
    id: `hist-${String(ALL_SEED.length - i).padStart(3, "0")}`,
    sql,
    connectionName,
    database,
    executedAt: new Date(now - ago * 60_000).toISOString(),
    executionTimeMs: ms,
    rowCount: rows,
    status: err ? "error" : "success",
    error: err ? err[2] : null,
    errorCode: err ? err[0] : null,
    errorSqlState: err ? err[1] : null,
    redacted: sql.includes("<redacted>"),
    truncated: false,
    origin,
    seq: i + 1,
  }));
}

let entries: Stored[] = seedEntries();
let nextSeq = entries.length + 1;

const strip = ({ seq: _seq, ...e }: Stored): HistoryEntry => e;

/** Newest first, rowid breaking ties: the order the prune keeps by. */
const byRecent = (a: Stored, b: Stored) =>
  a.executedAt < b.executedAt ? 1 : a.executedAt > b.executedAt ? -1 : b.seq - a.seq;

function matches(e: Stored, q: HistoryQuery): boolean {
  const search = q.search?.trim().toLowerCase();
  // SQLite's LIKE is case-insensitive for ASCII, which is what the search is.
  if (search && !e.sql.toLowerCase().includes(search)) return false;
  if (q.connectionNames?.length && !q.connectionNames.includes(e.connectionName)) return false;
  if (q.databases?.length && (e.database === null || !q.databases.includes(e.database))) return false;
  if (q.origins?.length && !q.origins.includes(e.origin)) return false;
  if (q.status && e.status !== q.status) return false;
  if (q.executedAfter && e.executedAt < q.executedAfter) return false;
  if (q.executedBefore && e.executedAt > q.executedBefore) return false;
  if (q.minDurationMs != null && e.executionTimeMs < q.minDurationMs) return false;
  return true;
}

function select(q: HistoryQuery | undefined): Stored[] {
  const query = q ?? ({} as HistoryQuery);
  const found = entries.filter((e) => matches(e, query));
  const sort = query.sort ?? "recent";
  found.sort(
    sort === "slowest"
      ? (a, b) => b.executionTimeMs - a.executionTimeMs || byRecent(a, b)
      : sort === "most_rows"
      ? (a, b) => b.rowCount - a.rowCount || byRecent(a, b)
      : byRecent,
  );
  const offset = query.offset ?? 0;
  return query.limit == null ? found.slice(offset) : found.slice(offset, offset + query.limit);
}

/** Drop the oldest beyond `limit`; returns how many went. */
function prune(limit: number): number {
  const keep = [...entries].sort(byRecent).slice(0, Math.max(0, limit));
  const removed = entries.length - keep.length;
  const kept = new Set(keep);
  entries = entries.filter((e) => kept.has(e));
  return removed;
}

const MAX_SQL_BYTES = 256 * 1024;
const TRUNCATION_MARKER = "\n-- … truncated by SQLPilot: statement too long to keep";

function store(entry: HistoryEntry): Stored {
  const cut = entry.sql.length > MAX_SQL_BYTES;
  return {
    ...entry,
    sql: cut ? entry.sql.slice(0, MAX_SQL_BYTES) + TRUNCATION_MARKER : entry.sql,
    truncated: cut || entry.truncated,
    seq: nextSeq++,
  };
}

function csvField(v: string): string {
  return /[,"\n\r]/.test(v) ? `"${v.replace(/"/g, "\"\"")}"` : v;
}

function render(list: HistoryEntry[], format: HistoryExportFormat): string {
  if (format === "csv") {
    const head = "executed_at,connection,database,status,duration_ms,rows,error_code,sql,error\n";
    return head + list.map((e) =>
      [
        csvField(e.executedAt),
        csvField(e.connectionName),
        csvField(e.database ?? ""),
        csvField(e.status),
        e.executionTimeMs,
        e.rowCount,
        e.errorCode ?? "",
        csvField(e.sql),
        csvField(e.error ?? ""),
      ].join(",") + "\n"
    ).join("");
  }
  let out = "-- SQLPilot query history export\n\n";
  for (const e of list) {
    out += `-- ${e.executedAt} · ${e.connectionName}${
      e.database ? `/${e.database}` : ""
    } · ${e.status} · ${e.executionTimeMs}ms\n`;
    if (e.error) out += `-- error: ${e.error.replace(/\n/g, " ")}\n`;
    if (e.redacted) out += "-- a credential was removed; this will not run as written\n";
    const sql = e.sql.trimEnd();
    out += `${sql}${sql.endsWith(";") ? "" : ";"}\n\n`;
  }
  return out;
}

const sortedDistinct = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();

export const historyHandlers: Handlers = {
  history_add: async ({ entry, limit }) => {
    await delay(20);
    const stored = store(entry as HistoryEntry);
    entries.push(stored);
    prune(Number(limit));
    return strip(stored);
  },
  history_list: async ({ query }) => {
    await delay(90);
    return select(query as HistoryQuery).map(strip);
  },
  history_count_matching: async ({ query }) => {
    await delay(40);
    return select({ ...(query as HistoryQuery), limit: null, offset: null }).length;
  },
  history_count: () => entries.length,
  history_remove: async ({ id }) => {
    await delay(30);
    entries = entries.filter((e) => e.id !== id);
    return null;
  },
  history_clear: async () => {
    await delay(30);
    entries = [];
    return null;
  },
  history_prune: ({ limit }) => prune(Number(limit)),
  history_prune_older_than: ({ cutoff }) => {
    const before = entries.length;
    entries = entries.filter((e) => e.executedAt >= String(cutoff));
    return before - entries.length;
  },
  // Ids carry across, so a second import of the same entries adds nothing.
  history_import: ({ entries: incoming, limit }) => {
    const ids = new Set(entries.map((e) => e.id));
    let imported = 0;
    for (const e of (incoming as HistoryEntry[] | undefined) ?? []) {
      if (ids.has(e.id)) continue;
      ids.add(e.id);
      entries.push(store(e));
      imported++;
    }
    prune(Number(limit));
    return imported;
  },
  history_facets: async (): Promise<HistoryFacets> => {
    await delay(40);
    return {
      connectionNames: sortedDistinct(entries.map((e) => e.connectionName)),
      databases: sortedDistinct(entries.map((e) => e.database)),
      origins: sortedDistinct(entries.map((e) => e.origin)),
    };
  },
  history_export: async ({ query, format }) => {
    await delay(120);
    const q = { ...(query as HistoryQuery), limit: null, offset: null };
    return render(select(q).map(strip), format as HistoryExportFormat);
  },
};
