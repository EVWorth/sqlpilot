// Schema reads: databases, tables, columns, keys, routines and their DDL.
//
// Answers the way `mas-core`'s SchemaInspector does, because the tree, the
// structure panel and the designer were written against its quirks:
//
// - The list reads query information_schema, so an unknown database or table
//   is not an error there, just an empty list. Only the `SHOW CREATE ...`
//   reads fail, with the server's error wrapped as a schema error.
// - `get_tables` includes views (TABLE_TYPE "VIEW", no engine, no sizes);
//   the tree filters them out of Tables and lists them from `get_views`.
// - Indexes come back sorted by name, as the backend's BTreeMap leaves them,
//   so PRIMARY sorts before the lowercase names.
//
// The indexes, keys, routines and the rest live here rather than in
// dataset.ts because nothing but these reads needs them.

import type {
  ColumnInfo,
  DatabaseInfo,
  EventInfo,
  ForeignKeyInfo,
  IndexInfo,
  PartitionInfo,
  RoutineInfo,
  TableInfo,
  TriggerInfo,
  ViewInfo,
} from "../../../lib/bindings";
import { DATABASES, type MockDatabase, type MockTable, rand } from "../dataset";
import { delay, fail, type Handlers } from "../router";
import { liveConnection } from "../state";

// ---------------------------------------------------------------- fixtures

const CHARSET = "utf8mb4";
const COLLATION = "utf8mb4_0900_ai_ci";
const DEFINER = "`root`@`localhost`";
/** InnoDB allocates in 16 KiB pages, so DATA_LENGTH is always a multiple. */
const PAGE = 16_384;
const BYTES_PER_ROW = 180;

interface IndexSpec {
  name: string;
  columns: string[];
  unique: boolean;
}

const primary = (...columns: string[]): IndexSpec => ({ name: "PRIMARY", columns, unique: true });
const unique = (name: string, ...columns: string[]): IndexSpec => ({ name, columns, unique: true });
const index = (name: string, ...columns: string[]): IndexSpec => ({ name, columns, unique: false });

/**
 * Keyed `database.table`. A base table missing here gets a PRIMARY from its
 * primary-key columns and nothing else.
 *
 * analytics.events has `occurred_at` in its primary key because MySQL
 * requires every unique key of a partitioned table to include the
 * partitioning column; a mock that skipped it would show a DDL the server
 * would refuse.
 */
const INDEXES: Record<string, IndexSpec[]> = {
  "shop.customers": [primary("id"), unique("uq_customers_email", "email")],
  "shop.products": [primary("id"), unique("uq_products_sku", "sku")],
  "shop.orders": [
    primary("id"),
    index("idx_orders_customer", "customer_id"),
    index("idx_orders_status_placed", "status", "placed_at"),
  ],
  "shop.order_items": [
    primary("id"),
    index("idx_order_items_order", "order_id"),
    index("idx_order_items_product", "product_id"),
  ],
  "analytics.events": [primary("id", "occurred_at"), index("idx_events_name_occurred", "name", "occurred_at")],
};

const FOREIGN_KEYS: Record<string, ForeignKeyInfo[]> = {
  "shop.orders": [
    {
      name: "fk_orders_customer",
      columns: ["customer_id"],
      referenced_table: "customers",
      referenced_columns: ["id"],
      on_update: "CASCADE",
      on_delete: "RESTRICT",
    },
  ],
  "shop.order_items": [
    {
      name: "fk_order_items_order",
      columns: ["order_id"],
      referenced_table: "orders",
      referenced_columns: ["id"],
      on_update: "CASCADE",
      on_delete: "CASCADE",
    },
    {
      name: "fk_order_items_product",
      columns: ["product_id"],
      referenced_table: "products",
      referenced_columns: ["id"],
      on_update: "CASCADE",
      on_delete: "RESTRICT",
    },
  ],
};

const VIEW_SQL: Record<string, { updatable: boolean; select: string }> = {
  "shop.order_totals": {
    // Aggregates make a view non-updatable, which the tree shows.
    updatable: false,
    select: "select `o`.`customer_id` AS `customer_id`,count(0) AS `orders`,sum(`o`.`total`) AS `lifetime_value` "
      + "from `shop`.`orders` `o` where (`o`.`status` <> 'refunded') group by `o`.`customer_id`",
  },
};

interface RoutineSpec extends RoutineInfo {
  database: string;
  ddl: string;
}

const ROUTINES: RoutineSpec[] = [
  {
    database: "shop",
    name: "customer_tier",
    routine_type: "FUNCTION",
    data_type: "varchar",
    ddl: `CREATE DEFINER=${DEFINER} FUNCTION \`customer_tier\`(customer_id INT) RETURNS varchar(16) CHARSET utf8mb4
    READS SQL DATA
    DETERMINISTIC
    COMMENT 'Loyalty tier from lifetime spend'
BEGIN
  DECLARE spend DECIMAL(32,2);
  SELECT lifetime_value INTO spend FROM order_totals WHERE order_totals.customer_id = customer_id;
  RETURN CASE
    WHEN spend IS NULL THEN 'none'
    WHEN spend >= 5000 THEN 'gold'
    WHEN spend >= 1000 THEN 'silver'
    ELSE 'bronze'
  END;
END`,
  },
  {
    database: "shop",
    name: "refresh_order_totals",
    routine_type: "PROCEDURE",
    // MySQL 8 reports an empty DATA_TYPE for a procedure.
    data_type: "",
    ddl: `CREATE DEFINER=${DEFINER} PROCEDURE \`refresh_order_totals\`()
    MODIFIES SQL DATA
    COMMENT 'Recalculates orders.total from the line items'
BEGIN
  UPDATE orders o
    JOIN (
      SELECT order_id, SUM(quantity * unit_price) AS total
      FROM order_items
      GROUP BY order_id
    ) t ON t.order_id = o.id
  SET o.total = t.total
  WHERE o.status <> 'refunded';
END`,
  },
];

interface TriggerSpec extends TriggerInfo {
  database: string;
  body: string;
}

const TRIGGERS: TriggerSpec[] = [
  {
    database: "shop",
    name: "orders_before_update",
    event: "UPDATE",
    table: "orders",
    timing: "BEFORE",
    body: `BEGIN
  IF OLD.status = 'refunded' AND NEW.status <> 'refunded' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A refunded order cannot change status';
  END IF;
END`,
  },
];

interface EventSpec extends EventInfo {
  database: string;
  /** What SHOW CREATE EVENT prints. */
  ddl: string;
}

/**
 * One recurring and enabled, one recurring and disabled, one one-off that has
 * not run yet: the three states the Events folder shows differently.
 */
const EVENTS: EventSpec[] = [
  {
    database: "analytics",
    name: "purge_old_events",
    event_type: "RECURRING",
    status: "ENABLED",
    definer: "root@localhost",
    interval: "1 DAY",
    comment: "Deletes raw events older than 180 days",
    ddl: "CREATE DEFINER=`root`@`localhost` EVENT `purge_old_events` ON SCHEDULE EVERY 1 DAY "
      + "STARTS '2026-07-02 03:00:00' ON COMPLETION NOT PRESERVE ENABLE COMMENT 'Deletes raw events older than 180 days' "
      + "DO DELETE FROM `events` WHERE `occurred_at` < NOW() - INTERVAL 180 DAY",
  },
  {
    database: "shop",
    name: "cancel_stale_orders",
    event_type: "RECURRING",
    status: "ENABLED",
    definer: "root@localhost",
    interval: "1 HOUR",
    comment: "Refunds orders left pending for more than 3 days",
    ddl: "CREATE DEFINER=`root`@`localhost` EVENT `cancel_stale_orders` ON SCHEDULE EVERY 1 HOUR "
      + "STARTS '2026-07-02 00:00:00' ON COMPLETION PRESERVE ENABLE "
      + "COMMENT 'Refunds orders left pending for more than 3 days' "
      + "DO UPDATE `orders` SET `status` = 'refunded' WHERE `status` = 'pending' AND `placed_at` < NOW() - INTERVAL 3 DAY",
  },
  {
    database: "shop",
    name: "refresh_order_totals_nightly",
    event_type: "RECURRING",
    status: "DISABLED",
    definer: "root@localhost",
    interval: "1 DAY",
    comment: "",
    ddl: "CREATE DEFINER=`root`@`localhost` EVENT `refresh_order_totals_nightly` ON SCHEDULE EVERY 1 DAY "
      + "STARTS '2026-07-03 02:30:00' ON COMPLETION NOT PRESERVE DISABLE DO CALL `refresh_order_totals`()",
  },
  {
    database: "shop",
    name: "close_q3_promotions",
    event_type: "ONE TIME",
    status: "ENABLED",
    definer: "root@localhost",
    interval: "",
    comment: "One-off: end the Q3 discount codes",
    ddl: "CREATE DEFINER=`root`@`localhost` EVENT `close_q3_promotions` ON SCHEDULE AT '2026-11-01 00:00:00' "
      + "ON COMPLETION NOT PRESERVE ENABLE COMMENT 'One-off: end the Q3 discount codes' "
      + "DO UPDATE `products` SET `price` = `price` WHERE 1 = 0",
  },
];

/** What SHOW CREATE EVENT prints for an event, if there is one. */
export function eventDdl(database: string, name: string): string | undefined {
  return EVENTS.find((e) => e.database === database && e.name === name)?.ddl;
}

/**
 * analytics.events, by month. RANGE needs an integer, and a TIMESTAMP column
 * is partitioned through UNIX_TIMESTAMP, so the bounds are epoch seconds just
 * as information_schema reports them.
 */
const EVENT_MONTHS: { month: number; share: number }[] = [
  { month: 4, share: 0.06 },
  { month: 5, share: 0.09 },
  { month: 6, share: 0.12 },
  { month: 7, share: 0.17 },
  { month: 8, share: 0.25 },
  { month: 9, share: 0.31 },
];

// ---------------------------------------------------------------- lookups

const key = (database: string, table: string) => `${database}.${table}`;
const ident = (name: string) => `\`${name.replace(/`/g, "``")}\``;
const sqlString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
const pages = (bytes: number) => Math.max(1, Math.ceil(bytes / PAGE)) * PAGE;

/** The backend's error text: CoreError::Schema around sqlx's database error. */
function serverError(code: string, message: string): never {
  return fail(`Schema error: error returned from database: ${code}: ${message}`);
}

function findDb(database: unknown): MockDatabase | undefined {
  return DATABASES.find((d) => d.name === String(database));
}

function findIn(database: unknown, table: unknown): MockTable | undefined {
  return findDb(database)?.tables.find((t) => t.name === String(table));
}

/** For the `SHOW CREATE` reads, which fail where the list reads go quiet. */
function requireTable(database: unknown, table: unknown): MockTable {
  if (!findDb(database)) serverError("1049 (42000)", `Unknown database '${String(database)}'`);
  return findIn(database, table)
    ?? serverError("1146 (42S02)", `Table '${String(database)}.${String(table)}' doesn't exist`);
}

function indexSpecs(database: string, table: MockTable): IndexSpec[] {
  if (table.table_type === "VIEW") return [];
  const spec = INDEXES[key(database, table.name)];
  if (spec) return spec;
  const pk = table.columns.filter((c) => c.is_primary_key).map((c) => c.name);
  return pk.length > 0 ? [primary(...pk)] : [];
}

function columnsOf(database: string, table: MockTable): ColumnInfo[] {
  // The PRIMARY index is the truth, so a composite key marks every column.
  const pk = indexSpecs(database, table).find((i) => i.name === "PRIMARY")?.columns;
  return table.columns.map((c) => ({
    name: c.name,
    data_type: c.data_type,
    column_type: c.column_type,
    nullable: c.nullable,
    default_value: c.default_value,
    is_primary_key: pk ? pk.includes(c.name) : c.is_primary_key,
    extra: c.extra,
    comment: c.comment,
    charset: c.charset,
    collation: c.collation,
  }));
}

/** A stable small number per table, so estimates differ but never change. */
function salt(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return h;
}

function tableInfo(table: MockTable): TableInfo {
  if (table.table_type === "VIEW") {
    return { name: table.name, table_type: "VIEW", engine: null, row_count: null, data_size: null, comment: "VIEW" };
  }
  // TABLE_ROWS is InnoDB's sampled estimate: exact for a tiny table, a few
  // percent off for a big one. Kept off the true count so the "approximate"
  // label in the structure panel has something to be about.
  const estimate = table.rowCount < 1000
    ? table.rowCount
    : Math.round(table.rowCount * (0.97 + rand(salt(table.name), 31) * 0.06));
  return {
    name: table.name,
    table_type: "BASE TABLE",
    engine: table.engine,
    row_count: estimate,
    data_size: pages(table.rowCount * BYTES_PER_ROW),
    comment: table.comment,
  };
}

function partitionsOf(database: string, table: string): PartitionInfo[] {
  if (key(database, table) !== "analytics.events") return [];
  const events = findIn(database, table);
  const total = events?.rowCount ?? 0;
  const rows = EVENT_MONTHS.map(({ month, share }) => {
    const rowCount = Math.round(total * share);
    return {
      name: `p2026_${String(month + 1).padStart(2, "0")}`,
      method: "RANGE",
      expression: "unix_timestamp(`occurred_at`)",
      description: String(Date.UTC(2026, month + 1, 1) / 1000),
      row_count: rowCount,
      data_size: pages(rowCount * BYTES_PER_ROW),
    };
  });
  // The catch-all, so an insert past the last month does not fail.
  rows.push({ ...rows[0], name: "p_future", description: "MAXVALUE", row_count: 0, data_size: PAGE });
  return rows;
}

// ---------------------------------------------------------------- DDL

const NO_DEFAULT_NULL = new Set([
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "tinyblob",
  "blob",
  "mediumblob",
  "longblob",
  "json",
  "geometry",
]);

/** One column as SHOW CREATE TABLE prints it. */
function columnLine(c: ColumnInfo): string {
  const parts = [ident(c.name), c.column_type];
  if (!c.nullable) parts.push("NOT NULL");
  if (c.default_value != null) {
    // Expression defaults print bare; literals are quoted, numbers included.
    const bare = /DEFAULT_GENERATED/i.test(c.extra) || /^CURRENT_TIMESTAMP/i.test(c.default_value);
    parts.push(`DEFAULT ${bare ? c.default_value : sqlString(c.default_value)}`);
  } else if (c.nullable && !NO_DEFAULT_NULL.has(c.data_type)) {
    // MySQL leaves DEFAULT NULL off TEXT, BLOB and JSON columns.
    parts.push("DEFAULT NULL");
  }
  if (/auto_increment/i.test(c.extra)) parts.push("AUTO_INCREMENT");
  const onUpdate = c.extra.match(/on update (\S+)/i);
  if (onUpdate) parts.push(`ON UPDATE ${onUpdate[1]}`);
  if (c.comment) parts.push(`COMMENT ${sqlString(c.comment)}`);
  return `  ${parts.join(" ")}`;
}

const keyColumns = (cols: string[]) => cols.map(ident).join(",");

function viewDdl(database: string, view: string): string {
  const select = VIEW_SQL[key(database, view)]?.select ?? `select 1 AS \`1\``;
  return `CREATE ALGORITHM=UNDEFINED DEFINER=${DEFINER} SQL SECURITY DEFINER VIEW ${ident(view)} AS ${select}`;
}

/** The text SHOW CREATE TABLE gives, built from the same fixtures the reads use. */
export function createTableDdl(database: string, table: MockTable): string {
  if (table.table_type === "VIEW") return viewDdl(database, table.name);

  const columns = columnsOf(database, table);
  const specs = indexSpecs(database, table);
  // SHOW CREATE TABLE lists the primary key, then unique keys, then the rest.
  const ordered = [
    ...specs.filter((i) => i.name === "PRIMARY"),
    ...specs.filter((i) => i.name !== "PRIMARY" && i.unique),
    ...specs.filter((i) => !i.unique),
  ];
  const lines = [
    ...columns.map(columnLine),
    ...ordered.map((i) =>
      i.name === "PRIMARY"
        ? `  PRIMARY KEY (${keyColumns(i.columns)})`
        : `  ${i.unique ? "UNIQUE KEY" : "KEY"} ${ident(i.name)} (${keyColumns(i.columns)})`
    ),
    ...(FOREIGN_KEYS[key(database, table.name)] ?? []).map((fk) => {
      // NO ACTION is what an unstated rule reads back as, and is not printed.
      const rules = [
        fk.on_delete !== "NO ACTION" ? ` ON DELETE ${fk.on_delete}` : "",
        fk.on_update !== "NO ACTION" ? ` ON UPDATE ${fk.on_update}` : "",
      ].join("");
      return `  CONSTRAINT ${ident(fk.name)} FOREIGN KEY (${keyColumns(fk.columns)}) REFERENCES ${
        ident(fk.referenced_table)
      } (${keyColumns(fk.referenced_columns)})${rules}`;
    }),
  ];

  // The next value is one past the highest id the row generator hands out.
  const auto = table.columns.find((c) => /auto_increment/i.test(c.extra));
  const options = [
    `ENGINE=${table.engine ?? "InnoDB"}`,
    auto ? `AUTO_INCREMENT=${Number(auto.gen(table.rowCount - 1)) + 1}` : "",
    `DEFAULT CHARSET=${CHARSET}`,
    `COLLATE=${COLLATION}`,
    table.comment ? `COMMENT=${sqlString(table.comment)}` : "",
  ].filter(Boolean).join(" ");

  let ddl = `CREATE TABLE ${ident(table.name)} (\n${lines.join(",\n")}\n) ${options}`;
  const partitions = partitionsOf(database, table.name);
  if (partitions.length > 0) {
    const parts = partitions.map((p) =>
      `PARTITION ${p.name} VALUES LESS THAN ${
        p.description === "MAXVALUE" ? "MAXVALUE" : `(${p.description})`
      } ENGINE = InnoDB`
    );
    ddl += `\n/*!50100 PARTITION BY ${partitions[0].method} (${partitions[0].expression})\n(${parts.join(",\n ")}) */`;
  }
  return ddl;
}

// ---------------------------------------------------------------- handlers

const sortByName = <T extends { name: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export const schemaHandlers: Handlers = {
  get_databases: async ({ connectionId }) => {
    liveConnection(connectionId);
    await delay(80);
    return sortByName(DATABASES).map((d): DatabaseInfo => ({
      name: d.name,
      default_charset: CHARSET,
      default_collation: COLLATION,
      is_system: d.is_system,
    }));
  },

  get_tables: async ({ connectionId, database }) => {
    liveConnection(connectionId);
    await delay(100);
    return sortByName(findDb(database)?.tables ?? []).map(tableInfo);
  },

  get_columns: async ({ connectionId, database, table }) => {
    liveConnection(connectionId);
    await delay(70);
    const t = findIn(database, table);
    return t ? columnsOf(String(database), t) : [];
  },

  get_indexes: async ({ connectionId, database, table }) => {
    liveConnection(connectionId);
    await delay(70);
    const t = findIn(database, table);
    if (!t) return [];
    return sortByName(indexSpecs(String(database), t)).map((i): IndexInfo => ({
      name: i.name,
      columns: i.columns,
      is_unique: i.unique,
      index_type: "BTREE",
    }));
  },

  get_foreign_keys: async ({ connectionId, database, table }) => {
    liveConnection(connectionId);
    await delay(70);
    return sortByName(FOREIGN_KEYS[key(String(database), String(table))] ?? []);
  },

  get_partitions: async ({ connectionId, database, table }) => {
    liveConnection(connectionId);
    await delay(70);
    return partitionsOf(String(database), String(table));
  },

  get_events: async ({ connectionId, database }) => {
    liveConnection(connectionId);
    await delay(90);
    return sortByName(EVENTS.filter((e) => e.database === database)).map((e): EventInfo => ({
      name: e.name,
      event_type: e.event_type,
      status: e.status,
      definer: e.definer,
      interval: e.interval,
      comment: e.comment,
    }));
  },

  get_views: async ({ connectionId, database }) => {
    liveConnection(connectionId);
    await delay(90);
    const views = (findDb(database)?.tables ?? []).filter((t) => t.table_type === "VIEW");
    return sortByName(views).map((v): ViewInfo => ({
      name: v.name,
      is_updatable: VIEW_SQL[key(String(database), v.name)]?.updatable ?? true,
    }));
  },

  get_routines: async ({ connectionId, database }) => {
    liveConnection(connectionId);
    await delay(90);
    // ORDER BY ROUTINE_TYPE, ROUTINE_NAME: functions before procedures.
    return ROUTINES.filter((r) => r.database === database)
      .sort((a, b) => a.routine_type.localeCompare(b.routine_type) || a.name.localeCompare(b.name))
      .map((r): RoutineInfo => ({ name: r.name, routine_type: r.routine_type, data_type: r.data_type }));
  },

  get_triggers: async ({ connectionId, database }) => {
    liveConnection(connectionId);
    await delay(90);
    return sortByName(TRIGGERS.filter((t) => t.database === database)).map(
      (t): TriggerInfo => ({ name: t.name, event: t.event, table: t.table, timing: t.timing }),
    );
  },

  get_table_ddl: async ({ connectionId, database, table }) => {
    liveConnection(connectionId);
    await delay(120);
    return createTableDdl(String(database), requireTable(database, table));
  },

  get_view_ddl: async ({ connectionId, database, viewName }) => {
    liveConnection(connectionId);
    await delay(120);
    const t = requireTable(database, viewName);
    if (t.table_type !== "VIEW") serverError("1347 (HY000)", `'${String(database)}.${t.name}' is not VIEW`);
    return viewDdl(String(database), t.name);
  },

  get_routine_ddl: async ({ connectionId, database, routineName, routineType }) => {
    liveConnection(connectionId);
    await delay(120);
    // Anything but FUNCTION is asked for as a procedure, as the backend does.
    const type = String(routineType).toUpperCase() === "FUNCTION" ? "FUNCTION" : "PROCEDURE";
    const routine = ROUTINES.find((r) => r.database === database && r.name === routineName && r.routine_type === type);
    return routine?.ddl
      ?? serverError("1305 (42000)", `${type} ${String(database)}.${String(routineName)} does not exist`);
  },

  get_trigger_ddl: async ({ connectionId, database, triggerName }) => {
    liveConnection(connectionId);
    await delay(120);
    const t = TRIGGERS.find((t) => t.database === database && t.name === triggerName);
    if (!t) return serverError("1360 (HY000)", "Trigger does not exist");
    return `CREATE DEFINER=${DEFINER} TRIGGER ${ident(t.name)} ${t.timing} ${t.event} ON ${
      ident(t.table)
    } FOR EACH ROW ${t.body}`;
  },
};
