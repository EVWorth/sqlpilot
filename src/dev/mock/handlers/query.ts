// Running SQL: the editor, EXPLAIN, cancel, grid saves and export.
//
// Not a SQL engine. Each statement is recognised by shape — SELECT from one
// table (with joins, projections, COUNT/SUM/... and GROUP BY over a sample),
// SELECT of constants, SHOW, DESCRIBE, the writes — and answered from the
// fixture world in dataset.ts. WHERE and ORDER BY are read only far enough to
// look right: `WHERE id = n` finds that row, anything else is ignored.
//
// What it does mimic carefully is what the UI reacts to: the error shapes
// (1064, 1146, 1054, the read-only refusal), the row cap and its truncation
// fields, per-statement results, the value types the backend sends (BIGINT and
// DECIMAL as text, TINYINT(1) as a boolean), and cancellation.
//
// Errors worth knowing about, for reviewing the error UI:
// - any statement containing `syntax_error`, or starting with a misspelt
//   verb (`SELEC`, `UPDAT`...), fails with 1064;
// - an unknown table fails with 1146, an unknown column with 1054;
// - a write on "Production (read-only)" is refused before anything runs;
// - `SELECT SLEEP(n)` really waits (up to 5s), and Cancel interrupts it with
//   1317.

import type {
  ConnectionInfo,
  ColumnMeta,
  ExplainFormat,
  ExplainResponse_Serialize,
  GridEditOutcome,
  QueryError,
  QueryResult_Deserialize,
  QueryResult_Serialize,
  SqlValue,
} from "@/lib/bindings";
import { DATABASES, type MockColumn, type MockTable, rand } from "../dataset";
import { delay, fail, type Handlers } from "../router";
import { liveConnection, newId, state } from "../state";
import { createTableDdl, schemaHandlers } from "./schema";

// ---------------------------------------------------------------- limits

/**
 * Where the memory guard stops a fetch nobody limited. The real floor is
 * free RAM, not a row count; a fixed number is what makes the "memory"
 * banner reachable with `SELECT * FROM analytics.events`.
 */
const MEMORY_GUARD_ROWS = 20_000;
/** Rows GROUP BY and the aggregates look at; counts are scaled up from it. */
const SAMPLE_ROWS = 5_000;
const MAX_SLEEP_MS = 5_000;
/** The dataset's notion of "now", so NOW() matches the generated dates. */
const NOW = "2026-10-18 12:00:00";

// ---------------------------------------------------------------- errors

function queryError(code: number | null, sqlState: string | null, message: string, index: number | null): QueryError {
  return { message, code, sqlState, statementIndex: index };
}

const sqlFail = (code: number, sqlState: string, message: string, index: number): never =>
  fail(queryError(code, sqlState, message, index));

const isQueryError = (e: unknown): e is QueryError =>
  typeof e === "object" && e !== null && typeof (e as QueryError).message === "string";

/** Commands that reject with a string show sqlx's rendering of the same error. */
function asDriverString(e: unknown): never {
  if (isQueryError(e) && e.code !== null) {
    return fail(`error returned from database: ${e.code} (${e.sqlState ?? "HY000"}): ${e.message}`);
  }
  throw e;
}

// ---------------------------------------------------------------- sessions and cancel

/** Pending waits per connection, so cancel_query can interrupt them. */
const inFlight = new Map<string, Set<() => void>>();
/** `connectionId/session` of editor tabs inside BEGIN ... COMMIT. */
const openTransactions = new Set<string>();
const sessionKey = (connectionId: string, session: unknown) => `${connectionId}/${String(session)}`;

/** A wait the way a running statement waits: until done, or killed. */
function busy(connectionId: string, ms: number, index: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const waits = inFlight.get(connectionId) ?? new Set();
    inFlight.set(connectionId, waits);
    const kill = () => {
      clearTimeout(timer);
      waits.delete(kill);
      // What KILL QUERY makes the server answer the statement with.
      reject(queryError(1317, "70100", "Query execution was interrupted", index));
    };
    // Read by `kill`, which cannot run before this line has.
    const timer = setTimeout(() => {
      waits.delete(kill);
      resolve();
    }, ms);
    waits.add(kill);
  });
}

// ---------------------------------------------------------------- text

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Split on `;` outside quotes and comments, as the backend's splitter does.
 * Comments stay in the statement text, which is what history records.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      current += c;
      if (c === "\\" && quote !== "`") current += sql[++i] ?? "";
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
      current += c;
    } else if ((c === "-" && sql[i + 1] === "-") || c === "#") {
      const end = sql.indexOf("\n", i);
      current += end === -1 ? sql.slice(i) : sql.slice(i, end);
      i = end === -1 ? sql.length : end - 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      current += end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === ";") {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(--|#)[^\n]*/g, " ").replace(/\s+/g, " ").trim();

const verbOf = (clean: string) => (/^[A-Za-z]+/.exec(clean)?.[0] ?? "").toUpperCase();

const IDENT = "(?:`[^`]+`|[A-Za-z_][\\w$]*)";
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
const unquote = (s: string) => s.trim().replace(/^`|`$/g, "");
const splitQualified = (raw: string) => raw.split(/\s*\.\s*/).map(unquote);

/** Split on commas that are not inside parentheses or quotes. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(Boolean);
}

// ---------------------------------------------------------------- classification

const READ_ONLY_VERBS = ["SELECT", "SHOW", "DESCRIBE", "DESC", "TABLE", "VALUES", "USE", "HELP", "CHECKSUM"];
const KNOWN_VERBS = new Set([
  ...READ_ONLY_VERBS,
  ...["EXPLAIN", "WITH", "INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER", "TRUNCATE"],
  ...["RENAME", "SET", "BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "GRANT", "REVOKE"],
  ...["FLUSH", "ANALYZE", "OPTIMIZE", "CHECK", "REPAIR", "CALL", "LOCK", "UNLOCK", "KILL", "DO"],
]);

/** The backend's `is_write_statement`, near enough. */
function isWrite(clean: string): boolean {
  const verb = verbOf(clean);
  if (verb === "EXPLAIN") {
    const rest = clean.replace(/^explain\s+/i, "");
    return /^analyze\s/i.test(rest) && isWrite(rest.replace(/^analyze\s+/i, ""));
  }
  if (verb === "WITH") return /\)\s*(insert|update|delete|replace)\b/i.test(clean);
  if (verb === "SET") return /^set\s+(global|persist)\b|@@(global|persist)/i.test(clean);
  return !READ_ONLY_VERBS.includes(verb);
}

function syntaxError(clean: string, version: string, index: number): void {
  const misspelt = /^(selec|slect|selet|updat|delet|insrt|inser|form|craete|creat)\b/i.exec(clean);
  const marker = /syntax_error/i.exec(clean);
  const unknownVerb = !KNOWN_VERBS.has(verbOf(clean));
  if (!misspelt && !marker && !unknownVerb) return;
  const near = clean.slice(marker ? marker.index : 0, (marker ? marker.index : 0) + 80);
  const server = version.toLowerCase().includes("mariadb") ? "MariaDB" : "MySQL";
  sqlFail(
    1064,
    "42000",
    `You have an error in your SQL syntax; check the manual that corresponds to your ${server} server version `
      + `for the right syntax to use near '${near}' at line 1`,
    index,
  );
}

// ---------------------------------------------------------------- values

/** The type name sqlx reports for a column, which is what ColumnMeta carries. */
function wireType(columnType: string): string {
  const t = columnType.toLowerCase();
  if (t === "tinyint(1)") return "BOOLEAN";
  const base = t.replace(/\(.*$/, "").replace(/ unsigned$/, "").toUpperCase();
  return t.includes("unsigned") ? `${base} UNSIGNED` : base;
}

/** The value as the backend sends it for that type (#502). */
function wireValue(v: SqlValue, type: string): SqlValue {
  if (v === null || v === "Null") return null;
  if (type === "BOOLEAN") return Boolean(v);
  if (type.startsWith("BIGINT") || type === "DECIMAL") return String(v);
  return v;
}

/**
 * Placeholders, as the real result metadata gives them: the backend cannot
 * read NOT NULL or PRIMARY KEY from a result set, and says so (#387).
 */
const meta = (name: string, data_type: string): ColumnMeta => ({ name, data_type, nullable: true, is_primary_key: false });

/** A computed value and the type MySQL would give it. */
function typed(v: SqlValue): { value: SqlValue; type: string } {
  if (v === null) return { value: null, type: "NULL" };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { value: String(v), type: "BIGINT" } : { value: String(+v.toFixed(4)), type: "DECIMAL" };
  }
  return { value: v, type: typeof v === "boolean" ? "BOOLEAN" : "VARCHAR" };
}

/** Arithmetic on number literals, for `SELECT 1 + 1`. */
function arithmetic(expr: string): number | undefined {
  if (!/^[\d\s+\-*/().]+$/.test(expr)) return undefined;
  const tokens = expr.match(/\d+(?:\.\d+)?|[+\-*/()]/g) ?? [];
  let pos = 0;
  const atom = (): number => {
    const t = tokens[pos++];
    if (t === "(") {
      const v = sum();
      pos++;
      return v;
    }
    if (t === "-") return -atom();
    return Number(t);
  };
  const product = (): number => {
    let v = atom();
    while (tokens[pos] === "*" || tokens[pos] === "/") v = tokens[pos++] === "*" ? v * atom() : v / atom();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[pos] === "+" || tokens[pos] === "-") v = tokens[pos++] === "+" ? v + product() : v - product();
    return v;
  };
  const v = sum();
  return Number.isFinite(v) && pos === tokens.length ? v : undefined;
}

interface Ctx {
  conn: ConnectionInfo;
  db: string | null;
  version: string;
  username: string;
  index: number;
}

/** A constant expression's value, or undefined when it is not one. */
function constant(expr: string, ctx: Ctx): SqlValue | undefined {
  const e = expr.trim();
  const str = /^'((?:[^']|'')*)'$|^"((?:[^"]|"")*)"$/.exec(e);
  if (str) return (str[1] ?? str[2]).replace(/''|""/g, (q) => q[0]);
  const fn = e.toUpperCase().replace(/\s+/g, "");
  const known: Record<string, SqlValue> = {
    "NULL": null,
    "TRUE": 1,
    "FALSE": 0,
    "VERSION()": ctx.version,
    "@@VERSION": ctx.version,
    "DATABASE()": ctx.db,
    "SCHEMA()": ctx.db,
    "NOW()": NOW,
    "CURRENT_TIMESTAMP": NOW,
    "CURRENT_TIMESTAMP()": NOW,
    "SYSDATE()": NOW,
    "CURDATE()": NOW.slice(0, 10),
    "CURRENT_DATE": NOW.slice(0, 10),
    "USER()": `${ctx.username}@localhost`,
    "CURRENT_USER()": `${ctx.username}@%`,
    "CONNECTION_ID()": 1000 + (hash(ctx.conn.id) % 9000),
  };
  if (fn in known) return known[fn];
  return arithmetic(e);
}

// ---------------------------------------------------------------- results

function result(
  ctx: Ctx,
  sql: string,
  columns: ColumnMeta[],
  rows: SqlValue[][],
  extra: Partial<QueryResult_Serialize> = {},
): QueryResult_Serialize {
  return {
    query_id: newId("query"),
    statement_index: ctx.index,
    sql,
    columns,
    rows,
    rows_affected: rows.length,
    execution_time_ms: 1 + Math.floor(rand(hash(sql) % 997, 31) * 6) + Math.floor(rows.length / 300),
    warnings: [],
    rows_truncated: false,
    ...extra,
  };
}

const affected = (ctx: Ctx, sql: string, n: number) => result(ctx, sql, [], [], { rows_affected: n });

interface Resolved {
  db: string;
  table: MockTable;
  alias: string;
}

/** A table reference, or the error MySQL gives for it. */
function resolveTable(raw: string, ctx: Ctx, alias?: string): Resolved | "system" {
  const parts = splitQualified(raw);
  const name = parts[parts.length - 1];
  const dbName = parts.length > 1 ? parts[0] : ctx.db;
  if (!dbName) return sqlFail(1046, "3D000", "No database selected", ctx.index);
  const db = DATABASES.find((d) => d.name.toLowerCase() === dbName.toLowerCase());
  if (!db) return sqlFail(1049, "42000", `Unknown database '${dbName}'`, ctx.index);
  // The system schemas have no fixtures. An empty answer reads as "nothing
  // there"; a 1146 for information_schema.TABLES would read as a bug.
  if (db.is_system) return "system";
  const table = db.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!table) return sqlFail(1146, "42S02", `Table '${db.name}.${name}' doesn't exist`, ctx.index);
  return { db: db.name, table, alias: alias ?? table.name };
}

const NOT_ALIAS = /^(where|join|left|right|inner|outer|cross|natural|on|using|order|group|having|limit|set|values|for|union|straight_join)$/i;

/** Every table a statement names in FROM, JOIN, UPDATE or INTO, in order. */
function tablesIn(clean: string, ctx: Ctx): Resolved[] | "system" {
  const re = new RegExp(`\\b(?:from|join|update|into)\\s+(${QUALIFIED})(?:\\s+(?:as\\s+)?(${IDENT}))?`, "gi");
  const out: Resolved[] = [];
  for (const m of clean.matchAll(re)) {
    if (unquote(m[1]).toLowerCase() === "dual") continue;
    const alias = m[2] && !NOT_ALIAS.test(m[2]) ? unquote(m[2]) : undefined;
    const r = resolveTable(m[1], ctx, alias);
    if (r === "system") return "system";
    out.push(r);
  }
  return out;
}

/** The row index `WHERE id = n` points at, or undefined for any other WHERE. */
function rowById(clean: string, table: MockTable): number[] | undefined {
  const m = /\bwhere\s+(?:\w+\.)?`?id`?\s*=\s*'?(\d+)'?\s*(?:$|limit|order|for)/i.exec(clean);
  const idCol = table.columns.find((c) => c.name === "id");
  if (!m || !idCol) return undefined;
  const i = Number(m[1]) - Number(idCol.gen(0));
  return i >= 0 && i < table.rowCount ? [i] : [];
}

// ---------------------------------------------------------------- SELECT

type Item =
  | { kind: "col"; name: string; col: MockColumn }
  | { kind: "agg"; name: string; fn: string; col: MockColumn | null }
  | { kind: "const"; name: string; value: SqlValue; type: string };

function projection(text: string, tables: Resolved[], ctx: Ctx): Item[] {
  const items: Item[] = [];
  for (const raw of splitTopLevel(text)) {
    const aliased = new RegExp(`^([\\s\\S]*?[^+\\-*/%(,\\s])\\s+(?:as\\s+)?(${IDENT}|'[^']*')$`, "i").exec(raw);
    const expr = aliased && !/^\w+\.$/.test(aliased[1]) ? aliased[1].trim() : raw;
    const label = aliased ? unquote(aliased[2].replace(/^'|'$/g, "")) : undefined;

    const star = /^(?:(`[^`]+`|\w+)\.)?\*$/.exec(expr);
    if (star) {
      const from = star[1] ? tables.filter((t) => t.alias === unquote(star[1]) || t.table.name === unquote(star[1])) : tables;
      for (const t of from) for (const col of t.table.columns) items.push({ kind: "col", name: col.name, col });
      continue;
    }
    const agg = /^(count|sum|avg|min|max)\s*\(\s*(distinct\s+)?([\s\S]*?)\s*\)$/i.exec(expr);
    if (agg) {
      const arg = agg[3];
      const col = arg === "*" || /^\d+$/.test(arg) ? null : findColumn(arg, tables, ctx);
      items.push({ kind: "agg", name: label ?? expr, fn: agg[1].toUpperCase(), col });
      continue;
    }
    if (new RegExp(`^${QUALIFIED}$`).test(expr) && constant(expr, ctx) === undefined) {
      items.push({ kind: "col", name: label ?? unquote(splitQualified(expr).pop() ?? expr), col: findColumn(expr, tables, ctx) });
      continue;
    }
    const { value, type } = typed(constant(expr, ctx) ?? null);
    items.push({ kind: "const", name: label ?? expr, value, type });
  }
  return items;
}

function findColumn(raw: string, tables: Resolved[], ctx: Ctx): MockColumn {
  const parts = splitQualified(raw);
  const name = parts[parts.length - 1];
  const qualifier = parts.length > 1 ? parts[parts.length - 2] : undefined;
  for (const t of tables) {
    if (qualifier && qualifier !== t.alias && qualifier !== t.table.name) continue;
    const col = t.table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (col) return col;
  }
  return sqlFail(1054, "42S22", `Unknown column '${parts.join(".")}' in 'field list'`, ctx.index);
}

const itemType = (item: Item) =>
  item.kind === "col"
    ? wireType(item.col.column_type)
    : item.kind === "const"
    ? item.type
    : item.fn === "COUNT"
    ? "BIGINT"
    : item.fn === "AVG" || !item.col
    ? "DECIMAL"
    : wireType(item.col.column_type);

/** GROUP BY and bare aggregates, computed over a sample and scaled up. */
function aggregate(items: Item[], groupBy: MockColumn[], table: MockTable): SqlValue[][] {
  const n = Math.min(table.rowCount, SAMPLE_ROWS);
  const scale = table.rowCount / Math.max(n, 1);
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = JSON.stringify(groupBy.map((c) => c.gen(i)));
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  if (groups.size === 0) groups.set("[]", []);
  return [...groups.values()].map((idxs) =>
    items.map((item) => {
      const type = itemType(item);
      if (item.kind === "const") return item.value;
      if (item.kind === "col") return idxs.length ? wireValue(item.col.gen(idxs[0]), type) : null;
      const col = item.col;
      const vals = col ? idxs.map((i) => col.gen(i)).filter((v) => v !== null) : idxs;
      if (item.fn === "COUNT") return String(Math.round(vals.length * scale));
      if (!vals.length) return null;
      const nums = vals.map(Number);
      const v = item.fn === "SUM"
        ? nums.reduce((a, b) => a + b, 0) * scale
        : item.fn === "AVG"
        ? nums.reduce((a, b) => a + b, 0) / nums.length
        : item.fn === "MIN"
        ? Math.min(...nums)
        : Math.max(...nums);
      // MIN and MAX of a non-numeric column are the values themselves.
      if ((item.fn === "MIN" || item.fn === "MAX") && Number.isNaN(v)) {
        const sorted = vals.map(String).sort();
        return item.fn === "MIN" ? sorted[0] : sorted[sorted.length - 1];
      }
      return type === "DECIMAL" ? v.toFixed(2) : wireValue(Math.round(v), type);
    })
  );
}

interface RowWindow {
  limit: number | null;
  offset: number | null;
}

async function select(stmt: string, clean: string, ctx: Ctx, win: RowWindow): Promise<QueryResult_Serialize> {
  const from = new RegExp(`\\bfrom\\s+(${QUALIFIED})`, "i").exec(clean);
  const projText = clean.slice(6, from ? from.index : undefined).trim();

  // No table: constants, functions, SLEEP.
  if (!from || unquote(from[1]).toLowerCase() === "dual") {
    const sleep = /^sleep\s*\(\s*([\d.]+)\s*\)$/i.exec(projText);
    if (sleep) {
      const ms = Math.min(Number(sleep[1]) * 1000, MAX_SLEEP_MS);
      await busy(ctx.conn.id, ms, ctx.index);
      return result(ctx, stmt, [meta(projText, "BIGINT")], [["0"]], { execution_time_ms: Math.round(ms) });
    }
    const items = projection(projText, [], ctx);
    return result(ctx, stmt, items.map((i) => meta(i.name, itemType(i))), [items.map((i) => (i.kind === "const" ? i.value : null))]);
  }

  const tables = tablesIn(clean, ctx);
  if (tables === "system" || tables.length === 0) return result(ctx, stmt, [], []);
  const main = tables[0].table;
  const items = projection(projText.replace(/^(distinct|sql_no_cache|sql_calc_found_rows)\s+/i, ""), tables, ctx);
  const columns = items.map((i) => meta(i.name, itemType(i)));
  const scanCost = Math.floor(main.rowCount / 40_000);

  const groupText = /\bgroup\s+by\s+([\s\S]+?)(?:\s+(?:having|order|limit)\b|$)/i.exec(clean)?.[1];
  if (groupText || items.some((i) => i.kind === "agg")) {
    const groupBy = groupText ? splitTopLevel(groupText).map((g) => findColumn(g, tables, ctx)) : [];
    const rows = aggregate(items, groupBy, main);
    return result(ctx, stmt, columns, rows, { execution_time_ms: 3 + scanCost * 2 });
  }

  // The statement's own LIMIT, then the caller's page over what it yields.
  const lim = /\blimit\s+(\d+)(?:\s*,\s*(\d+)|\s+offset\s+(\d+))?\s*(?:for\s+update)?$/i.exec(clean);
  const sqlOffset = lim ? Number(lim[2] !== undefined ? lim[1] : lim[3] ?? 0) : 0;
  const sqlCount = lim ? Number(lim[2] ?? lim[1]) : Infinity;
  const byId = rowById(clean, main);
  const indexes = byId ?? null;
  const produced = indexes ? indexes.length : Math.max(0, Math.min(main.rowCount - sqlOffset, sqlCount));
  const skip = win.offset ?? 0;
  const remaining = Math.max(0, produced - skip);

  let take = remaining;
  let reason: QueryResult_Serialize["truncation_reason"] = null;
  if (win.limit !== null && remaining > win.limit) {
    take = win.limit;
    reason = "row_limit";
  } else if (remaining > MEMORY_GUARD_ROWS) {
    take = MEMORY_GUARD_ROWS;
    reason = "memory_guard";
  }

  const rowIdx = indexes ?? Array.from({ length: take }, (_, k) => sqlOffset + skip + k);
  const types = items.map(itemType);
  const rows = rowIdx.slice(0, take).map((i) =>
    items.map((item, c) => (item.kind === "const" ? item.value : item.kind === "col" ? wireValue(item.col.gen(i), types[c]) : null))
  );
  // Skipped when nothing was withheld, as serde's skip_serializing_if does;
  // when something was, the backend reports the count it kept.
  const truncation = reason
    ? { rows_truncated: true, truncation_reason: reason, total_rows_available: rows.length }
    : {};
  const r = result(ctx, stmt, columns, rows, truncation);
  r.execution_time_ms += indexes ? 0 : scanCost;
  return r;
}

// ---------------------------------------------------------------- SHOW and DESCRIBE

const SYSTEM_VARIABLES = (version: string): [string, string][] => [
  ["character_set_server", "utf8mb4"],
  ["collation_server", "utf8mb4_0900_ai_ci"],
  ["innodb_buffer_pool_size", "134217728"],
  ["max_connections", "151"],
  ["sql_mode", "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION"],
  ["time_zone", "SYSTEM"],
  ["version", version],
  ["wait_timeout", "28800"],
];

const text = (...names: string[]) => names.map((n) => meta(n, "VARCHAR"));

function describe(stmt: string, raw: string, ctx: Ctx): QueryResult_Serialize {
  const r = resolveTable(raw, ctx);
  const cols = text("Field", "Type", "Null", "Key", "Default", "Extra");
  if (r === "system") return result(ctx, stmt, cols, []);
  return result(
    ctx,
    stmt,
    cols,
    r.table.columns.map((c) => [
      c.name,
      c.column_type,
      c.nullable ? "YES" : "NO",
      c.is_primary_key ? "PRI" : "",
      c.default_value,
      c.extra,
    ]),
  );
}

/**
 * SHOW CREATE <object>, which the schema tree's "Show DDL" runs through the
 * editor. The DDL itself comes from the schema handlers, so the tree's DDL
 * view and this agree.
 */
async function showCreate(stmt: string, kind: string, raw: string, ctx: Ctx): Promise<QueryResult_Serialize> {
  const parts = splitQualified(raw);
  const name = parts[parts.length - 1];
  const database = parts.length > 1 ? parts[0] : ctx.db ?? sqlFail(1046, "3D000", "No database selected", ctx.index);
  const session = ["utf8mb4", "utf8mb4_0900_ai_ci"];
  const fromSchema = async (cmd: string, args: Record<string, unknown>): Promise<string> => {
    try {
      return String(await schemaHandlers[cmd]({ connectionId: ctx.conn.id, database, ...args }));
    } catch (e) {
      // The schema handlers fail the way the schema commands do, as text
      // around the driver's code; the editor gets it structured.
      const m = /(\d+) \((\w+)\): (.*)$/.exec(String(e));
      return m ? sqlFail(Number(m[1]), m[2], m[3], ctx.index) : fail(queryError(null, null, String(e), ctx.index));
    }
  };

  if (kind === "TABLE" || kind === "VIEW") {
    const r = resolveTable(raw, { ...ctx, db: database });
    if (r === "system") return sqlFail(1146, "42S02", `Table '${database}.${name}' doesn't exist`, ctx.index);
    const ddl = createTableDdl(r.db, r.table);
    if (r.table.table_type === "VIEW") {
      return result(ctx, stmt, text("View", "Create View", "character_set_client", "collation_connection"), [[r.table.name, ddl, ...session]]);
    }
    if (kind === "VIEW") return sqlFail(1347, "HY000", `'${r.db}.${r.table.name}' is not VIEW`, ctx.index);
    return result(ctx, stmt, text("Table", "Create Table"), [[r.table.name, ddl]]);
  }
  if (kind === "PROCEDURE" || kind === "FUNCTION") {
    const ddl = await fromSchema("get_routine_ddl", { routineName: name, routineType: kind });
    const label = kind === "PROCEDURE" ? "Procedure" : "Function";
    return result(
      ctx,
      stmt,
      text(label, "sql_mode", `Create ${label}`, "character_set_client", "collation_connection", "Database Collation"),
      [[name, SYSTEM_VARIABLES(ctx.version)[4][1], ddl, ...session, session[1]]],
    );
  }
  if (kind === "TRIGGER") {
    const ddl = await fromSchema("get_trigger_ddl", { triggerName: name });
    return result(
      ctx,
      stmt,
      text("Trigger", "sql_mode", "SQL Original Statement", "character_set_client", "collation_connection", "Database Collation", "Created"),
      [[name, SYSTEM_VARIABLES(ctx.version)[4][1], ddl, ...session, session[1], "2026-07-02 09:14:00.00"]],
    );
  }
  // EVENT. The schema handlers have no DDL read for events, and there is one.
  if (database !== "analytics" || name !== "purge_old_events") {
    return sqlFail(1539, "HY000", `Unknown event '${name}'`, ctx.index);
  }
  const ddl = "CREATE DEFINER=`root`@`localhost` EVENT `purge_old_events` ON SCHEDULE EVERY 1 DAY "
    + "STARTS '2026-07-02 03:00:00' ON COMPLETION NOT PRESERVE ENABLE COMMENT 'Deletes raw events older than 180 days' "
    + "DO DELETE FROM `events` WHERE `occurred_at` < NOW() - INTERVAL 180 DAY";
  return result(
    ctx,
    stmt,
    text("Event", "sql_mode", "time_zone", "Create Event", "character_set_client", "collation_connection", "Database Collation"),
    [[name, SYSTEM_VARIABLES(ctx.version)[4][1], "SYSTEM", ddl, ...session, session[1]]],
  );
}

async function show(stmt: string, clean: string, ctx: Ctx): Promise<QueryResult_Serialize> {
  let m: RegExpExecArray | null;
  if (/^show\s+(databases|schemas)\b/i.test(clean)) {
    const names = DATABASES.map((d) => d.name).sort();
    return result(ctx, stmt, text("Database"), names.map((n) => [n]));
  }
  if ((m = new RegExp(`^show\\s+(full\\s+)?tables(?:\\s+(?:from|in)\\s+(${IDENT}))?`, "i").exec(clean))) {
    const dbName = m[2] ? unquote(m[2]) : ctx.db;
    if (!dbName) return sqlFail(1046, "3D000", "No database selected", ctx.index);
    const db = DATABASES.find((d) => d.name === dbName) ?? sqlFail(1049, "42000", `Unknown database '${dbName}'`, ctx.index);
    const tables = [...db.tables].sort((a, b) => a.name.localeCompare(b.name));
    const cols = text(`Tables_in_${db.name}`, ...(m[1] ? ["Table_type"] : []));
    return result(ctx, stmt, cols, tables.map((t) => (m?.[1] ? [t.name, t.table_type] : [t.name])));
  }
  if ((m = new RegExp(`^show\\s+(?:full\\s+)?(?:columns|fields)\\s+(?:from|in)\\s+(${QUALIFIED})(?:\\s+(?:from|in)\\s+(${IDENT}))?`, "i").exec(clean))) {
    return describe(stmt, m[2] ? `${m[2]}.${m[1]}` : m[1], ctx);
  }
  if ((m = new RegExp(`^show\\s+create\\s+(table|view|procedure|function|trigger|event)\\s+(${QUALIFIED})`, "i").exec(clean))) {
    return showCreate(stmt, m[1].toUpperCase(), m[2], ctx);
  }
  if (/^show\s+(global\s+|session\s+)?variables\b/i.test(clean)) {
    const like = /\blike\s+'([^']*)'/i.exec(clean)?.[1];
    const re = like ? new RegExp(`^${like.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "i") : null;
    const rows = SYSTEM_VARIABLES(ctx.version).filter(([n]) => !re || re.test(n));
    return result(ctx, stmt, text("Variable_name", "Value"), rows);
  }
  // Anything else answers with an empty set rather than failing.
  return result(ctx, stmt, [], []);
}

// ---------------------------------------------------------------- writes

function rowsWritten(clean: string, verb: string, ctx: Ctx): number {
  const tables = tablesIn(clean, ctx);
  if (tables === "system") return 0;
  const target = tables[0];
  if (!target) return 0;
  if (verb === "INSERT" || verb === "REPLACE") {
    const values = /\bvalues?\s*([\s\S]*)$/i.exec(clean)?.[1];
    return values ? (values.match(/\)\s*,\s*\(/g)?.length ?? 0) + 1 : 1 + (hash(clean) % 40);
  }
  const byId = rowById(clean, target.table);
  if (byId) return byId.length;
  if (!/\bwhere\b/i.test(clean)) return target.table.rowCount;
  return 1 + Math.floor(rand(hash(clean) % 997, 41) * Math.min(target.table.rowCount, 500) * 0.1);
}

// ---------------------------------------------------------------- EXPLAIN

interface PlanRow {
  table: Resolved | null;
  type: string | null;
  key: string | null;
  ref: string | null;
  rows: number | null;
  filtered: number;
  extra: string | null;
}

function planRows(target: string, ctx: Ctx): PlanRow[] {
  const clean = stripComments(target);
  const tables = tablesIn(clean, ctx);
  if (tables === "system" || tables.length === 0) {
    return [{ table: null, type: null, key: null, ref: null, rows: null, filtered: 0, extra: "No tables used" }];
  }
  const where = /\bwhere\b/i.test(clean);
  const byId = rowById(clean, tables[0].table);
  const notes = [
    where && !byId ? "Using where" : null,
    /\bgroup\s+by\b/i.test(clean) ? "Using temporary" : null,
    /\border\s+by\b/i.test(clean) && !/\border\s+by\s+(\w+\.)?`?id`?\b/i.test(clean) ? "Using filesort" : null,
  ].filter(Boolean).join("; ") || null;
  return tables.map((t, i): PlanRow => {
    if (i === 0) {
      return byId
        ? { table: t, type: "const", key: "PRIMARY", ref: "const", rows: 1, filtered: 100, extra: notes }
        : { table: t, type: "ALL", key: null, ref: null, rows: t.table.rowCount, filtered: where ? 10 : 100, extra: notes };
    }
    // A join: assume it goes through the joined table's primary key, by the
    // `<singular>_id` column convention the dataset follows.
    const ref = `${tables[0].db}.${tables[0].alias}.${t.table.name.replace(/s$/, "")}_id`;
    return { table: t, type: "eq_ref", key: "PRIMARY", ref, rows: 1, filtered: 100, extra: null };
  });
}

const cost = (rows: number) => (rows * 0.1 + 0.25).toFixed(2);

function classicPlan(stmt: string, target: string, ctx: Ctx, measured: boolean): QueryResult_Serialize {
  const verb = verbOf(stripComments(target));
  const selectType = ["UPDATE", "DELETE", "INSERT", "REPLACE"].includes(verb) ? verb : "SIMPLE";
  const columns = [
    meta("id", "BIGINT"),
    ...text("select_type", "table", "partitions", "type", "possible_keys", "key", "key_len", "ref"),
    meta("rows", "BIGINT UNSIGNED"),
    meta("filtered", "DOUBLE"),
    ...(measured ? [meta("r_rows", "DOUBLE"), meta("r_filtered", "DOUBLE")] : []),
    meta("Extra", "VARCHAR"),
  ];
  const rows = planRows(target, ctx).map((p) => [
    "1",
    selectType,
    p.table?.alias ?? null,
    p.table?.db === "analytics" && p.table.table.name === "events" ? "p202608,p202609,p202610" : null,
    p.type,
    p.key,
    p.key,
    p.key ? "4" : null,
    p.ref,
    p.rows === null ? null : String(p.rows),
    p.filtered,
    ...(measured ? [p.rows === null ? null : Math.round(p.rows * (p.filtered / 100)), p.filtered] : []),
    p.extra,
  ]);
  return result(ctx, stmt, columns, rows);
}

function jsonPlan(stmt: string, target: string, ctx: Ctx): QueryResult_Serialize {
  const plan = planRows(target, ctx);
  const tableNode = (p: PlanRow) => ({
    table: {
      table_name: p.table?.alias,
      access_type: p.type,
      ...(p.key ? { possible_keys: [p.key], key: p.key, used_key_parts: ["id"], key_length: "4", ref: [p.ref] } : {}),
      rows_examined_per_scan: p.rows,
      rows_produced_per_join: Math.round((p.rows ?? 0) * (p.filtered / 100)),
      filtered: p.filtered.toFixed(2),
      cost_info: {
        read_cost: cost((p.rows ?? 0) * 0.9),
        eval_cost: cost((p.rows ?? 0) * 0.1),
        prefix_cost: cost(p.rows ?? 0),
        data_read_per_join: `${Math.max(1, Math.round(((p.rows ?? 0) * 180) / 1024))}K`,
      },
      used_columns: p.table?.table.columns.map((c) => c.name),
      ...(p.extra?.includes("Using where") ? { attached_condition: "<condition from the WHERE clause>" } : {}),
    },
  });
  const total = plan.reduce((a, p) => a + (p.rows ?? 0), 0);
  const block = plan[0].table === null
    ? { select_id: 1, message: "No tables used" }
    : {
      select_id: 1,
      cost_info: { query_cost: cost(total) },
      ...(plan.length > 1 ? { nested_loop: plan.map(tableNode) } : tableNode(plan[0])),
    };
  return result(ctx, stmt, [meta("EXPLAIN", "JSON")], [[JSON.stringify({ query_block: block }, null, 2)]]);
}

function treePlan(stmt: string, target: string, ctx: Ctx, analyzed: boolean): QueryResult_Serialize {
  const plan = planRows(target, ctx);
  const actual = (rows: number) =>
    analyzed ? ` (actual time=${(0.02 + rand(rows, 51)).toFixed(3)}..${(rows / 900 + 0.4).toFixed(3)} rows=${rows} loops=1)` : "";
  const node = (p: PlanRow): string => {
    const rows = p.rows ?? 1;
    if (p.type === "const") return `-> Rows fetched before execution  (cost=0..0 rows=1)${actual(1)}`;
    if (p.type === "eq_ref") {
      return `-> Single-row index lookup on ${p.table?.alias} using PRIMARY (id=${p.ref?.split(".").slice(1).join(".")})  (cost=0.25 rows=1)${actual(1)}`;
    }
    const scan = `-> Table scan on ${p.table?.alias}  (cost=${cost(rows)} rows=${rows})${actual(rows)}`;
    return p.extra?.includes("Using where")
      ? `-> Filter: (<condition>)  (cost=${cost(rows)} rows=${Math.round(rows / 10)})${actual(Math.round(rows / 10))}\n    ${scan}`
      : scan;
  };
  const textPlan = plan[0].table === null
    ? `-> Rows fetched before execution  (cost=0..0 rows=1)${actual(1)}`
    : plan.length === 1
    ? node(plan[0])
    : [`-> Nested loop inner join  (cost=${cost(plan[0].rows ?? 1)} rows=${plan[0].rows})${actual(plan[0].rows ?? 1)}`]
      .concat(plan.map((p) => node(p).replace(/^/gm, "    ")))
      .join("\n");
  return result(ctx, stmt, [meta("EXPLAIN", "VARCHAR")], [[textPlan]]);
}

/** EXPLAIN typed into the editor rather than asked for with the button. */
function explainStatement(stmt: string, clean: string, ctx: Ctx): QueryResult_Serialize {
  const rest = clean.replace(/^(explain|describe|desc)\s+/i, "");
  const format = /^format\s*=\s*(\w+)\s+/i.exec(rest);
  const analyze = /^analyze\s+/i.test(rest);
  const target = rest.replace(/^format\s*=\s*\w+\s+/i, "").replace(/^analyze\s+/i, "");
  const f = format?.[1].toLowerCase();
  if (analyze || f === "tree") return treePlan(stmt, target, ctx, analyze);
  if (f === "json") return jsonPlan(stmt, target, ctx);
  return classicPlan(stmt, target, ctx, false);
}

// ---------------------------------------------------------------- dispatch

function contextFor(connectionId: unknown, database: unknown, index = 0): { ctx: Ctx; readOnly: boolean } {
  const conn = liveConnection(connectionId);
  const profile = state.profiles.find((p) => p.id === conn.profile_id);
  return {
    ctx: {
      conn,
      db: typeof database === "string" && database ? database : conn.database,
      version: conn.server_version,
      username: profile?.username ?? "root",
      index,
    },
    readOnly: profile?.read_only ?? false,
  };
}

/** The backend's refusal, raised before any statement of the script runs. */
function refuseWrite(sql: string): never {
  return fail(queryError(null, null, `Read-only connection: This connection is marked read-only, so it will not run: ${sql.slice(0, 120)}`, null));
}

async function runStatement(stmt: string, ctx: Ctx, win: RowWindow, session: unknown): Promise<QueryResult_Serialize> {
  const clean = stripComments(stmt);
  syntaxError(clean, ctx.version, ctx.index);
  const verb = verbOf(clean);
  const key = sessionKey(ctx.conn.id, session);
  let m: RegExpExecArray | null;

  switch (verb) {
    case "SELECT":
      return select(stmt, clean, ctx, win);
    case "TABLE":
      return select(stmt, `SELECT * FROM ${clean.slice(6)}`, ctx, win);
    case "WITH":
      // The CTE's own body is not modelled; the outer SELECT is.
      return select(stmt, clean.replace(/^with[\s\S]*\)\s*(?=select\b)/i, ""), ctx, win);
    case "SHOW":
      return show(stmt, clean, ctx);
    case "DESCRIBE":
    case "DESC":
      if ((m = new RegExp(`^desc(?:ribe)?\\s+(${QUALIFIED})\\s*$`, "i").exec(clean))) return describe(stmt, m[1], ctx);
      return explainStatement(stmt, clean, ctx);
    case "EXPLAIN":
      return explainStatement(stmt, clean, ctx);
    case "USE": {
      const name = unquote(clean.slice(3));
      if (!DATABASES.some((d) => d.name === name)) return sqlFail(1049, "42000", `Unknown database '${name}'`, ctx.index);
      return affected(ctx, stmt, 0);
    }
    case "BEGIN":
    case "START":
      if (session) openTransactions.add(key);
      return affected(ctx, stmt, 0);
    case "COMMIT":
    case "ROLLBACK":
      if (!/^rollback\s+to\b/i.test(clean)) openTransactions.delete(key);
      return affected(ctx, stmt, 0);
    case "INSERT":
    case "REPLACE":
    case "UPDATE":
    case "DELETE": {
      const n = rowsWritten(clean, verb, ctx);
      const r = affected(ctx, stmt, n);
      r.execution_time_ms += Math.floor(n / 200);
      return r;
    }
    default:
      // DDL and everything else: OK, nothing affected.
      return affected(ctx, stmt, 0);
  }
}

// ---------------------------------------------------------------- export

const cellText = (v: SqlValue): string =>
  v === null || v === "Null" ? "" : Array.isArray(v) ? `0x${v.map((b) => b.toString(16).padStart(2, "0")).join("")}` : String(v);

const sqlLiteral = (v: SqlValue): string =>
  v === null || v === "Null"
    ? "NULL"
    : typeof v === "number" || typeof v === "boolean"
    ? String(Number(v))
    : Array.isArray(v)
    ? cellText(v)
    : `'${v.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

function exportText(r: QueryResult_Deserialize, format: string, tableName: string): string {
  const names = r.columns.map((c) => c.name);
  switch (format) {
    case "csv": {
      const field = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      return [names, ...r.rows.map((row) => row.map(cellText))].map((line) => line.map(field).join(",")).join("\n") + "\n";
    }
    case "json":
      return JSON.stringify(
        r.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i] === "Null" ? null : row[i]]))),
        null,
        2,
      );
    case "sql": {
      const cols = names.map((n) => `\`${n}\``).join(", ");
      return r.rows.map((row) => `INSERT INTO \`${tableName}\` (${cols}) VALUES (${row.map(sqlLiteral).join(", ")});`).join("\n") + "\n";
    }
    case "markdown": {
      const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
      return [line(names), line(names.map(() => "---")), ...r.rows.map((row) => line(row.map(cellText)))].join("\n") + "\n";
    }
    default:
      return fail(`Unknown format: ${format}`);
  }
}

// ---------------------------------------------------------------- handlers

export const queryHandlers: Handlers = {
  execute_query: async (args): Promise<QueryResult_Serialize[]> => {
    const { ctx, readOnly } = contextFor(args.connectionId, args.database);
    const statements = splitStatements(String(args.sql ?? "")).filter((s) => stripComments(s));
    if (readOnly) {
      const write = statements.find((s) => isWrite(stripComments(s)));
      if (write) refuseWrite(write);
    }
    const win: RowWindow = {
      limit: typeof args.limit === "number" ? args.limit : null,
      offset: typeof args.offset === "number" ? args.offset : null,
    };
    const results: QueryResult_Serialize[] = [];
    for (const [index, stmt] of statements.entries()) {
      const r = await runStatement(stmt, { ...ctx, index }, win, args.session);
      // What the statement "took", spent waiting so the spinner shows; the
      // SLEEP branch has already waited its own time.
      if (!/^select\s+sleep\s*\(/i.test(stripComments(stmt))) await busy(ctx.conn.id, Math.min(600, 60 + r.execution_time_ms), index);
      results.push(r);
    }
    return results;
  },

  explain_query: async (args): Promise<ExplainResponse_Serialize> => {
    const { ctx, readOnly } = contextFor(args.connectionId, args.database);
    const statements = splitStatements(String(args.sql ?? "")).filter((s) => stripComments(s));
    if (statements.length === 0) return fail("Query error: Nothing to explain");
    if (statements.length > 1) {
      return fail(`Query error: EXPLAIN supports a single statement — ${statements.length} were given. Select one statement and re-run.`);
    }
    const target = statements[0];
    const analyzable = ["SELECT", "TABLE", "VALUES"].includes(verbOf(stripComments(target)));
    const refusal = !args.analyze ? null : readOnly ? "read_only_connection" : !analyzable ? "would_mutate" : null;
    const analyze = Boolean(args.analyze) && refusal === null;
    const maria = ctx.version.toLowerCase().includes("mariadb");
    const asked = (args.format ?? "classic") as ExplainFormat;

    // `plan_statement` in mas-core: what each server can answer for each ask.
    let format: ExplainFormat = asked;
    let fallback: ExplainResponse_Serialize["format_fallback"] = null;
    // What actually ran timed. The response still says `analyzed` whenever
    // ANALYZE was permitted, as `explain_in` does.
    let timed = analyze;
    if (asked === "tree" && maria) {
      format = "classic";
      fallback = "tree_not_supported";
    } else if (asked === "classic" && analyze && !maria) {
      format = "tree";
    } else if (asked === "json" && analyze) {
      fallback = maria ? "none" : "analyze_json_not_supported";
      timed = maria;
    }
    const prefix = format === "json"
      ? `${timed && maria ? "ANALYZE" : "EXPLAIN"} FORMAT=JSON`
      : maria && timed
      ? "ANALYZE"
      : timed
      ? "EXPLAIN ANALYZE"
      : format === "tree"
      ? "EXPLAIN FORMAT=TREE"
      : "EXPLAIN";
    const stmt = `${prefix} ${target}`;

    try {
      syntaxError(stripComments(target), ctx.version, 0);
      const r = format === "json"
        ? jsonPlan(stmt, target, ctx)
        : format === "tree"
        ? treePlan(stmt, target, ctx, timed)
        : classicPlan(stmt, target, ctx, timed);
      // ANALYZE runs the statement, so it takes about as long as the query.
      await delay(timed ? 450 : 140);
      return { result: r, analyzed: analyze, refusal, tabular: r.columns.length > 1, format, format_fallback: fallback };
    } catch (e) {
      return asDriverString(e);
    }
  },

  cancel_query: async (args): Promise<null> => {
    const waits = inFlight.get(String(args.connectionId));
    await delay(40);
    for (const kill of [...(waits ?? [])]) kill();
    return null;
  },

  close_session: (args): null => {
    // Closing a session rolls back what it left open, as the server does.
    openTransactions.delete(sessionKey(String(args.connectionId), args.session));
    return null;
  },

  apply_grid_edits: async (args): Promise<GridEditOutcome | null> => {
    const { ctx, readOnly } = contextFor(args.connectionId, args.database);
    const statements = (args.statements as string[]) ?? [];
    if (readOnly) {
      const write = statements.find((s) => isWrite(stripComments(s)));
      if (write) refuseWrite(write);
    }
    await delay(180);
    const rows_affected = statements.map((s, index) => {
      const clean = stripComments(s);
      syntaxError(clean, ctx.version, index);
      return rowsWritten(clean, verbOf(clean), { ...ctx, index });
    });
    const transaction = openTransactions.has(sessionKey(ctx.conn.id, args.session)) ? "open" : "none";
    return { rows_affected, transaction };
  },

  export_results: async (args): Promise<string> => {
    await delay(80);
    const tableName = typeof args.tableName === "string" && args.tableName ? args.tableName : "table";
    return exportText(args.result as QueryResult_Deserialize, String(args.format), tableName);
  },
};
