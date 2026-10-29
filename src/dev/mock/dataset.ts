// A small, believable world for the mock backend to serve.
//
// Two connection profiles worth of servers, each with a couple of user
// databases and the usual system schemas. Rows are generated from a fixed
// seed, so every screenshot of the same screen shows the same data.

import type { ColumnInfo, ConnectionProfileSummary_Serialize, SqlValue } from "../../lib/bindings";

export interface MockColumn extends ColumnInfo {
  /** Makes the value for row `i` (0-based). */
  gen: (i: number) => SqlValue;
}

export interface MockTable {
  name: string;
  table_type: "BASE TABLE" | "VIEW";
  engine: string | null;
  comment: string;
  columns: MockColumn[];
  rowCount: number;
}

export interface MockDatabase {
  name: string;
  is_system: boolean;
  tables: MockTable[];
}

// ---------------------------------------------------------------- helpers

/** Deterministic pseudo-random in [0, 1) for row `i` and a salt. */
export function rand(i: number, salt = 0): number {
  const x = Math.sin((i + 1) * 9301 + salt * 49297) * 233280;
  return x - Math.floor(x);
}

const pick = <T>(xs: T[], i: number, salt = 0): T => xs[Math.floor(rand(i, salt) * xs.length)];

function col(
  name: string,
  column_type: string,
  gen: (i: number) => SqlValue,
  opts: Partial<ColumnInfo> = {},
): MockColumn {
  const data_type = column_type.replace(/\(.*$/, "").replace(/ unsigned$/, "");
  return {
    name,
    data_type,
    column_type,
    nullable: false,
    default_value: null,
    is_primary_key: false,
    extra: "",
    comment: "",
    charset: null,
    collation: null,
    gen,
    ...opts,
  };
}

const id = (name = "id") => col(name, "int unsigned", (i) => i + 1, { is_primary_key: true, extra: "auto_increment" });

const FIRST = [
  "Ada",
  "Grace",
  "Linus",
  "Margaret",
  "Alan",
  "Barbara",
  "Dennis",
  "Frances",
  "Ken",
  "Radia",
  "Tim",
  "Hedy",
  "Edsger",
  "Katherine",
  "Donald",
  "Annie",
];
const LAST = [
  "Lovelace",
  "Hopper",
  "Torvalds",
  "Hamilton",
  "Turing",
  "Liskov",
  "Ritchie",
  "Allen",
  "Thompson",
  "Perlman",
  "Berners-Lee",
  "Lamarr",
  "Dijkstra",
  "Johnson",
  "Knuth",
  "Easley",
];
const CITIES = ["Lisbon", "Oslo", "Toronto", "Nairobi", "Osaka", "Austin", "Berlin", "Lima", "Perth", "Dublin"];
const PRODUCTS = [
  "Mechanical keyboard",
  "USB-C hub",
  "27\" monitor",
  "Desk lamp",
  "Noise-cancelling headphones",
  "Laptop stand",
  "Webcam",
  "Ergonomic mouse",
  "Cable organiser",
  "Standing desk mat",
  "Portable SSD 1TB",
  "Wireless charger",
];
const STATUSES = ["pending", "paid", "shipped", "delivered", "refunded"];

export function isoDate(i: number, daysBack = 400): string {
  const base = Date.UTC(2026, 9, 18, 12, 0, 0);
  const t = base - Math.floor(rand(i, 7) * daysBack * 86_400_000);
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

// ---------------------------------------------------------------- shop

const shop: MockDatabase = {
  name: "shop",
  is_system: false,
  tables: [
    {
      name: "customers",
      table_type: "BASE TABLE",
      engine: "InnoDB",
      comment: "People who have placed at least one order",
      rowCount: 1_284,
      columns: [
        id(),
        col("first_name", "varchar(64)", (i) => pick(FIRST, i, 1)),
        col("last_name", "varchar(64)", (i) => pick(LAST, i, 2)),
        col(
          "email",
          "varchar(255)",
          (i) =>
            `${pick(FIRST, i, 1).toLowerCase()}.${
              pick(LAST, i, 2).toLowerCase().replace(/[^a-z]/g, "")
            }${i}@example.com`,
          { comment: "Unique per customer" },
        ),
        col("city", "varchar(64)", (i) => (rand(i, 3) < 0.08 ? null : pick(CITIES, i, 3)), { nullable: true }),
        col("is_active", "tinyint(1)", (i) => (rand(i, 4) < 0.9 ? 1 : 0), { default_value: "1" }),
        col("created_at", "datetime", (i) => isoDate(i), {
          default_value: "CURRENT_TIMESTAMP",
          extra: "DEFAULT_GENERATED",
        }),
      ],
    },
    {
      name: "products",
      table_type: "BASE TABLE",
      engine: "InnoDB",
      comment: "",
      rowCount: PRODUCTS.length,
      columns: [
        id(),
        col("sku", "char(8)", (i) => `SKU-${String(1000 + i * 7).padStart(4, "0")}`),
        col("name", "varchar(128)", (i) => PRODUCTS[i % PRODUCTS.length]),
        col("price", "decimal(10,2)", (i) => (19 + Math.floor(rand(i, 5) * 480) + 0.99).toFixed(2)),
        col("stock", "int", (i) => Math.floor(rand(i, 6) * 300)),
        col(
          "description",
          "text",
          (i) => (rand(i, 8) < 0.3
            ? null
            : `The ${PRODUCTS[i % PRODUCTS.length].toLowerCase()} everyone on the team ends up asking about.`),
          { nullable: true },
        ),
      ],
    },
    {
      name: "orders",
      table_type: "BASE TABLE",
      engine: "InnoDB",
      comment: "",
      rowCount: 9_412,
      columns: [
        id(),
        col("customer_id", "int unsigned", (i) => 1 + Math.floor(rand(i, 9) * 1284), { extra: "" }),
        col("status", "enum('pending','paid','shipped','delivered','refunded')", (i) => pick(STATUSES, i, 10), {
          default_value: "pending",
        }),
        col("total", "decimal(10,2)", (i) => (10 + rand(i, 11) * 900).toFixed(2)),
        col("placed_at", "datetime", (i) => isoDate(i, 200)),
        col(
          "notes",
          "json",
          (i) => (rand(i, 12) < 0.7
            ? null
            : JSON.stringify({ gift: rand(i, 13) < 0.5, channel: pick(["web", "app", "phone"], i, 14) })),
          { nullable: true },
        ),
      ],
    },
    {
      name: "order_items",
      table_type: "BASE TABLE",
      engine: "InnoDB",
      comment: "",
      rowCount: 23_870,
      columns: [
        id(),
        col("order_id", "int unsigned", (i) => 1 + Math.floor(i / 2.5)),
        col("product_id", "int unsigned", (i) => 1 + Math.floor(rand(i, 15) * PRODUCTS.length)),
        col("quantity", "smallint unsigned", (i) => 1 + Math.floor(rand(i, 16) * 4)),
        col("unit_price", "decimal(10,2)", (i) => (19 + rand(i, 17) * 480).toFixed(2)),
      ],
    },
    {
      name: "order_totals",
      table_type: "VIEW",
      engine: null,
      comment: "VIEW",
      rowCount: 1_284,
      columns: [
        col("customer_id", "int unsigned", (i) => i + 1),
        col("orders", "bigint", (i) => 1 + Math.floor(rand(i, 18) * 20)),
        col("lifetime_value", "decimal(32,2)", (i) => (50 + rand(i, 19) * 9000).toFixed(2), { nullable: true }),
      ],
    },
  ],
};

// ---------------------------------------------------------------- analytics

const analytics: MockDatabase = {
  name: "analytics",
  is_system: false,
  tables: [
    {
      name: "events",
      table_type: "BASE TABLE",
      engine: "InnoDB",
      comment: "Raw product analytics, partitioned by month",
      rowCount: 4_812_330,
      columns: [
        col("id", "bigint unsigned", (i) => 10_000_000 + i, { is_primary_key: true, extra: "auto_increment" }),
        col("user_id", "int unsigned", (i) => 1 + Math.floor(rand(i, 20) * 50_000), { nullable: true }),
        col(
          "name",
          "varchar(64)",
          (i) => pick(["page_view", "signup", "checkout_started", "checkout_completed", "search"], i, 21),
        ),
        col(
          "properties",
          "json",
          (i) =>
            JSON.stringify({
              path: pick(["/", "/pricing", "/docs", "/cart"], i, 22),
              ms: Math.floor(rand(i, 23) * 900),
            }),
        ),
        col("occurred_at", "timestamp(3)", (i) => isoDate(i, 30)),
      ],
    },
    {
      name: "daily_signups",
      table_type: "BASE TABLE",
      engine: "InnoDB",
      comment: "",
      rowCount: 365,
      columns: [
        col("day", "date", (i) => isoDate(i, 365).slice(0, 10), { is_primary_key: true }),
        col("signups", "int", (i) => 40 + Math.floor(rand(i, 24) * 120)),
        col("source", "varchar(32)", (i) => pick(["organic", "ads", "referral"], i, 25)),
      ],
    },
  ],
};

const system = (name: string): MockDatabase => ({ name, is_system: true, tables: [] });

export const DATABASES: MockDatabase[] = [
  analytics,
  system("information_schema"),
  system("mysql"),
  system("performance_schema"),
  shop,
  system("sys"),
];

/**
 * The fixture as it was loaded, so `resetDatabases` can undo what the schema
 * writes did. Tables keep their identity across a reset, because handlers
 * hold on to them (agent.ts counts rows in `shop.orders`).
 */
const SEED_WORLD = DATABASES.map((db) => ({
  db,
  tables: db.tables.map((table) => ({ table, fields: { ...table, columns: [...table.columns] } })),
}));

export function resetDatabases(): void {
  DATABASES.splice(0, DATABASES.length, ...SEED_WORLD.map((s) => s.db));
  for (const { db, tables } of SEED_WORLD) {
    db.tables = tables.map(({ table, fields }) => Object.assign(table, { ...fields, columns: [...fields.columns] }));
  }
}

export function findTable(database: string | null | undefined, table: string): MockTable | undefined {
  const dbs = database ? DATABASES.filter((d) => d.name === database) : DATABASES;
  for (const db of dbs) {
    const t = db.tables.find((t) => t.name.toLowerCase() === table.toLowerCase());
    if (t) return t;
  }
  return undefined;
}

/** Materialise rows `offset..offset+limit` of a table. */
export function tableRows(table: MockTable, offset = 0, limit = 200): SqlValue[][] {
  const end = Math.min(table.rowCount, offset + limit);
  const rows: SqlValue[][] = [];
  for (let i = offset; i < end; i++) rows.push(table.columns.map((c) => c.gen(i)));
  return rows;
}

// ---------------------------------------------------------------- profiles

const created = "2026-07-02T09:14:00Z";

export const PROFILES: ConnectionProfileSummary_Serialize[] = [
  {
    id: "profile-local",
    name: "Local dev",
    group: "Work",
    color: "#22c55e",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    default_database: "shop",
    ssh_config: null,
    ssl_config: null,
    pool_min: 1,
    pool_max: 5,
    read_only: false,
    connect_timeout_secs: 10,
    query_timeout_secs: null,
    charset: "utf8mb4",
    environment: "development",
    created_at: created,
    updated_at: created,
  },
  {
    id: "profile-staging",
    name: "Staging",
    group: "Work",
    color: "#f59e0b",
    host: "db.staging.example.internal",
    port: 3306,
    username: "app",
    default_database: "shop",
    ssh_config: null,
    ssl_config: null,
    pool_min: 1,
    pool_max: 5,
    read_only: false,
    connect_timeout_secs: 10,
    query_timeout_secs: 30,
    charset: "utf8mb4",
    environment: "staging",
    created_at: created,
    updated_at: created,
  },
  {
    id: "profile-prod",
    name: "Production (read-only)",
    group: "Work",
    color: "#ef4444",
    host: "db.prod.example.internal",
    port: 3306,
    username: "readonly",
    default_database: "shop",
    ssh_config: null,
    ssl_config: null,
    pool_min: 1,
    pool_max: 5,
    read_only: true,
    connect_timeout_secs: 10,
    query_timeout_secs: 15,
    charset: "utf8mb4",
    environment: "production",
    created_at: created,
    updated_at: created,
  },
  {
    id: "profile-maria",
    name: "MariaDB sandbox",
    group: null,
    color: null,
    host: "localhost",
    port: 3307,
    username: "dev",
    default_database: null,
    ssh_config: null,
    ssl_config: null,
    pool_min: 1,
    pool_max: 5,
    read_only: false,
    connect_timeout_secs: null,
    query_timeout_secs: null,
    charset: null,
    environment: null,
    created_at: created,
    updated_at: created,
  },
];

/**
 * The profiles `?mock=servers` adds, one per connect outcome the default set
 * cannot show. Their behaviour is in handlers/connections.ts.
 */
export const SERVER_PROFILES: ConnectionProfileSummary_Serialize[] = [
  {
    ...PROFILES[2],
    id: "profile-prod-rw",
    name: "Production (read-write)",
    host: "db-primary.prod.example.internal",
    username: "admin",
    read_only: false,
  },
  {
    ...PROFILES[3],
    id: "profile-mariadb",
    name: "MariaDB 11",
    group: "Lab",
    color: "#0ea5e9",
    host: "mariadb.lab.example.internal",
    port: 3306,
    username: "dev",
    default_database: "shop",
  },
  {
    ...PROFILES[3],
    id: "profile-bad-password",
    name: "Wrong password",
    group: "Lab",
    host: "db.qa.example.internal",
    port: 3306,
    username: "app",
  },
  {
    ...PROFILES[3],
    id: "profile-timeout",
    name: "Unreachable (times out)",
    group: "Lab",
    host: "10.20.30.40",
    port: 3306,
    username: "app",
    connect_timeout_secs: 2,
  },
];

export const SERVER_VERSION: Record<string, string> = {
  "profile-local": "8.0.39",
  "profile-staging": "8.0.36",
  "profile-prod": "8.0.36",
  "profile-maria": "11.4.3-MariaDB",
  "profile-prod-rw": "8.0.36",
  "profile-mariadb": "11.4.3-MariaDB-ubu2404",
};
