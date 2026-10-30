// SQLite files: open, browse, query.
//
// Every path opens the same small `app.db`, because a browser has no files to
// read. What comes back mirrors `mas-sqlite` rather than an idealised SQLite:
// query results carry every column as nullable TEXT, `PRAGMA table_info`'s
// quirks (an INTEGER PRIMARY KEY reads as nullable) survive, and the internal
// tables and auto-indexes are left out, as the real inspector leaves them out.

import type {
  ForeignKeyInfo,
  QueryError,
  QueryResult,
  SqliteColumnInfo,
  SqliteIndexInfo,
  SqliteQueryResult,
  SqliteTableInfo,
} from "../../../lib/bindings";
import { isoDate, rand } from "../dataset";
import { type Args, delay, fail, type Handlers } from "../router";
import { newId } from "../state";

type Value = string | number | null;

interface FakeTable {
  name: string;
  ddl: string;
  columns: SqliteColumnInfo[];
  indexes: SqliteIndexInfo[];
  /** As `PRAGMA foreign_key_list` reports them, named `fk_<table>_<id>`. */
  foreignKeys?: ForeignKeyInfo[];
  rows: Value[][];
}

const column = (
  name: string,
  data_type: string,
  opts: Partial<SqliteColumnInfo> = {},
): SqliteColumnInfo => ({
  name,
  data_type,
  nullable: true,
  default_value: null,
  is_primary_key: false,
  ...opts,
});

const NOTE_TITLES = [
  "Groceries",
  "Release checklist",
  "Ideas for the offsite",
  "Book list",
  "Index to add on orders",
  "Questions for the vendor",
  "Trip packing list",
  "Meeting notes",
];

const NOTES: FakeTable = {
  name: "notes",
  ddl: [
    "CREATE TABLE notes (",
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "  title TEXT NOT NULL,",
    "  body TEXT,",
    "  created_at TEXT NOT NULL DEFAULT (datetime('now'))",
    ")",
  ].join("\n"),
  columns: [
    // SQLite reports an INTEGER PRIMARY KEY as nullable: `notnull` is 0 in
    // `PRAGMA table_info`, and the inspector passes that straight through.
    column("id", "INTEGER", { is_primary_key: true }),
    column("title", "TEXT", { nullable: false }),
    column("body", "TEXT"),
    column("created_at", "TEXT", { nullable: false, default_value: "datetime('now')" }),
  ],
  indexes: [{ name: "idx_notes_created_at", columns: ["created_at"], is_unique: false }],
  rows: Array.from({ length: 24 }, (_, i) => [
    i + 1,
    `${NOTE_TITLES[i % NOTE_TITLES.length]}${
      i >= NOTE_TITLES.length ? ` (${Math.floor(i / NOTE_TITLES.length) + 1})` : ""
    }`,
    rand(i, 31) < 0.2 ? null : `Note ${i + 1}: things to remember, written down so they stop rattling around.`,
    isoDate(i + 40, 120),
  ]),
};

const SETTINGS: FakeTable = {
  name: "settings",
  ddl: "CREATE TABLE settings (\n  key TEXT PRIMARY KEY,\n  value TEXT\n)",
  columns: [column("key", "TEXT", { is_primary_key: true }), column("value", "TEXT")],
  // The primary key's index is `sqlite_autoindex_settings_1`, which the
  // inspector filters out with the other `sqlite_` names.
  indexes: [],
  rows: [
    ["theme", "dark"],
    ["editor.font_size", "13"],
    ["sync.enabled", "false"],
    ["last_opened_tab", "notes"],
    ["locale", "en-GB"],
    ["schema_version", "4"],
  ],
};

/** A table with a foreign key, so the structure view has one to show (#924). */
const NOTE_TAGS: FakeTable = {
  name: "note_tags",
  ddl: [
    "CREATE TABLE note_tags (",
    "  note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,",
    "  tag TEXT NOT NULL,",
    "  PRIMARY KEY (note_id, tag)",
    ")",
  ].join("\n"),
  columns: [
    column("note_id", "INTEGER", { nullable: false, is_primary_key: true }),
    column("tag", "TEXT", { nullable: false, is_primary_key: true }),
  ],
  // The composite primary key's index is a `sqlite_autoindex_`, left out.
  indexes: [],
  foreignKeys: [{
    // SQLite keeps no constraint names; the backend makes this one up.
    name: "fk_note_tags_0",
    columns: ["note_id"],
    referenced_table: "notes",
    referenced_columns: ["id"],
    on_update: "NO ACTION",
    on_delete: "CASCADE",
  }],
  rows: [
    [1, "shopping"],
    [2, "work"],
    [2, "release"],
    [3, "work"],
    [5, "reading"],
    [8, "work"],
  ],
};

const TABLES = [NOTES, NOTE_TAGS, SETTINGS];

/**
 * A view, so the Views folder has something in it (#825). `sqlite_master`
 * lists it beside the tables, with type "view" and no row count.
 */
const RECENT_NOTES: FakeTable = {
  name: "recent_notes",
  ddl: "CREATE VIEW recent_notes AS\n  SELECT id, title, created_at FROM notes\n  ORDER BY created_at DESC LIMIT 10",
  columns: [
    column("id", "INTEGER"),
    column("title", "TEXT"),
    column("created_at", "TEXT"),
  ],
  indexes: [],
  rows: [...NOTES.rows]
    .sort((a, b) => String(b[3]).localeCompare(String(a[3])))
    .slice(0, 10)
    .map((r) => [r[0], r[1], r[3]]),
};

const VIEWS = [RECENT_NOTES];

/** Open files, by connection id. */
const sessions = new Map<string, string>();

function session(connectionId: unknown): string {
  const path = sessions.get(String(connectionId));
  if (path === undefined) fail(`Not found: SQLite connection not found: ${String(connectionId)}`);
  return path;
}

/** A table or a view: both can be selected from and described. */
function table(name: string): FakeTable | undefined {
  return [...TABLES, ...VIEWS].find((t) => t.name === name.toLowerCase());
}

function queryError(message: string, statementIndex: number): never {
  const error: QueryError = { message, code: 1, sqlState: null, statementIndex };
  fail(error);
}

/**
 * The table a statement names, unquoted: `"notes"`, `[notes]`, `main.notes`,
 * and the tree's `` `main`.`notes` ``, whose quoted schema was read as the
 * table name.
 */
const TARGET = /\b(?:from|into|update|table)\s+(?:["`[]?main["`\]]?\.)?["`[]?(\w+)["`\]]?/i;

function result(index: number, sql: string, columns: string[], rows: Value[][], affected = 0): SqliteQueryResult {
  return {
    query_id: newId("sqlite-query"),
    statement_index: index,
    sql,
    // Every column as nullable TEXT, as the executor reports them: it reads
    // names from the statement and never asks SQLite for declared types.
    columns: columns.map((name) => ({ name, data_type: "TEXT", nullable: true, is_primary_key: false })),
    rows,
    rows_affected: affected,
    execution_time_ms: 1 + (sql.length % 4),
    warnings: [],
    rows_truncated: false,
  };
}

/** A literal from a select list with no FROM: `1`, `'x'`, `sqlite_version()`. */
function literal(expr: string): Value {
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  const quoted = /^'(.*)'$/.exec(expr);
  if (quoted) return quoted[1];
  if (/^sqlite_version\(\)$/i.test(expr)) return "3.46.1";
  return null;
}

/**
 * Just enough of SELECT to make the grid and the editor believable: the
 * table, `*` or named columns, `COUNT(*)`, and `LIMIT`/`OFFSET`. WHERE and
 * ORDER BY are ignored — the rows come back in key order regardless.
 */
function select(sql: string, index: number): SqliteQueryResult {
  if (/^(pragma|explain)\b/i.test(sql)) return result(index, sql, [], []);
  const list = /^select\s+(.*?)(?:\s+from\s|$)/is.exec(sql)?.[1]?.trim() ?? "*";
  const name = TARGET.exec(sql)?.[1];
  if (!name) {
    const exprs = list.split(",").map((e) => e.trim());
    return result(index, sql, exprs, [exprs.map(literal)]);
  }
  const t = table(name) ?? queryError(`no such table: ${name}`, index);
  if (/^count\(\s*\*\s*\)$/i.test(list)) return result(index, sql, [list], [[t.rows.length]]);

  const names = t.columns.map((c) => c.name);
  const wanted = list.split(",").map((e) => e.trim().replace(/^["`[]|["`\]]$/g, ""));
  const picked = list === "*" || !wanted.every((w) => names.includes(w)) ? names : wanted;
  const limit = /\blimit\s+(\d+)(?:\s*(?:,|offset)\s*(\d+))?/i.exec(sql);
  let rows = t.rows;
  if (limit) {
    // `LIMIT a, b` is offset-then-count; `LIMIT a OFFSET b` is the reverse.
    const comma = /\blimit\s+\d+\s*,/i.test(sql);
    const count = Number(comma ? limit[2] : limit[1]);
    const offset = Number(comma ? limit[1] : limit[2] ?? 0);
    rows = rows.slice(offset, offset + count);
  }
  const at = picked.map((c) => names.indexOf(c));
  return result(index, sql, picked, rows.map((r) => at.map((i) => r[i])));
}

/** Anything else reports a plausible row count and changes nothing. */
function write(sql: string, index: number): SqliteQueryResult {
  const verb = /^\w+/.exec(sql)?.[0].toUpperCase() ?? "";
  if (!["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(verb)) return result(index, sql, [], []);
  const name = TARGET.exec(sql)?.[1] ?? "";
  const t = table(name) ?? queryError(`no such table: ${name}`, index);
  if (VIEWS.includes(t)) queryError(`cannot modify ${t.name} because it is a view`, index);
  const affected = verb === "INSERT" || verb === "REPLACE"
    ? Math.max(1, (sql.match(/\)\s*(,|$)/g) ?? []).length)
    : /\bwhere\b/i.test(sql)
    ? 1
    : t.rows.length;
  return result(index, sql, [], [], affected);
}

/**
 * Split a script as `mas-sqlite` does (#928): its splitter is a port of
 * `sqlite3_complete`, and this is the same state machine. Semicolons inside
 * strings, quoted names and comments do not split, a trigger body runs to its
 * `END;`, and a piece with nothing but comments in it is not a statement.
 * Each statement comes back trimmed and without its `;`, as the backend's
 * `sql` field has it.
 */
export function splitSqliteStatements(sql: string): string[] {
  // Rows are states, columns tokens: SEMI WS OTHER EXPLAIN CREATE TEMP TRIGGER END.
  const TRANSITIONS = [
    [1, 0, 2, 3, 4, 2, 2, 2],
    [1, 1, 2, 3, 4, 2, 2, 2],
    [1, 2, 2, 2, 2, 2, 2, 2],
    [1, 3, 3, 2, 4, 2, 2, 2],
    [1, 4, 2, 2, 2, 4, 5, 2],
    [6, 5, 5, 5, 5, 5, 5, 5],
    [6, 6, 5, 5, 5, 5, 5, 7],
    [1, 7, 5, 5, 5, 5, 5, 5],
  ];
  const [SEMI, WS, OTHER] = [0, 1, 2];
  const KEYWORDS: Record<string, number> = { explain: 3, create: 4, temp: 5, temporary: 5, trigger: 6, end: 7 };
  const idChar = /[A-Za-z0-9_$\u0080-\uffff]/;
  const upTo = (from: number, needle: string, extra: number) => {
    const at = sql.indexOf(needle, from);
    return at === -1 ? sql.length : at + extra;
  };

  const out: string[] = [];
  let state = 0;
  let start = 0;
  let hasContent = false;
  const push = (end: number) => {
    const text = sql.slice(start, end).trim().replace(/;$/, "").trimEnd();
    if (hasContent) out.push(text);
  };
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    let token = OTHER;
    let end = i + 1;
    if (ch === ";") token = SEMI;
    else if (/\s/.test(ch)) token = WS;
    else if (ch === "/" && sql[i + 1] === "*") [token, end] = [WS, upTo(i + 2, "*/", 2)];
    else if (ch === "-" && sql[i + 1] === "-") [token, end] = [WS, upTo(i, "\n", 1)];
    else if (ch === "[") end = upTo(i, "]", 1);
    else if (ch === "'" || ch === "\"" || ch === "`") end = upTo(i + 1, ch, 1);
    else if (idChar.test(ch)) {
      while (end < sql.length && idChar.test(sql[end])) end++;
      token = KEYWORDS[sql.slice(i, end).toLowerCase()] ?? OTHER;
    }
    state = TRANSITIONS[state][token];
    if (token === SEMI && state === 1) {
      push(end);
      start = end;
      hasContent = false;
    } else if (token !== SEMI && token !== WS) {
      hasContent = true;
    }
    i = end;
  }
  push(sql.length);
  return out;
}

const isQueryError = (e: unknown): e is QueryError =>
  typeof e === "object" && e !== null && "message" in e && "statementIndex" in e;

/** A SQLite result in the shared shape, as `completedResults` carries it. */
const shared = (r: SqliteQueryResult): QueryResult => ({
  ...r,
  columns: r.columns.map((c) => ({ ...c })),
  rows: r.rows as QueryResult["rows"],
});

export const sqliteHandlers: Handlers = {
  sqlite_open: async ({ path }: Args) => {
    await delay(150);
    const p = String(path ?? "");
    // One way to fail, so the error state of the open flow can be looked at.
    if (/\.(txt|csv|json)$/i.test(p)) fail(`Not found: ${p} is not a SQLite database`);
    const id = newId("sqlite");
    sessions.set(id, p);
    return id;
  },

  sqlite_close: ({ connectionId }: Args) => {
    session(connectionId);
    sessions.delete(String(connectionId));
    return null;
  },

  sqlite_list: () => [...sessions.keys()],

  sqlite_execute: async ({ connectionId, sql }: Args) => {
    session(connectionId);
    await delay(80);
    // One result per statement; the first failure stops the run and carries
    // what ran before it, as the backend reports it (#928).
    const results: SqliteQueryResult[] = [];
    for (const [i, s] of splitSqliteStatements(String(sql ?? "")).entries()) {
      try {
        const body = s.replace(/^\s*(--[^\n]*\n\s*)*/, "");
        const r = /^(select|pragma|explain|with)\b/i.test(body) ? select(body, i) : write(body, i);
        results.push({ ...r, sql: s });
      } catch (e) {
        if (isQueryError(e) && results.length > 0) fail({ ...e, completedResults: results.map(shared) });
        throw e;
      }
    }
    return results;
  },

  sqlite_get_tables: ({ connectionId }: Args): SqliteTableInfo[] => {
    session(connectionId);
    // In name order, as `ORDER BY name` returns them.
    return [
      ...TABLES.map((t) => ({ name: t.name, table_type: "table", row_count: t.rows.length, sql: t.ddl })),
      ...VIEWS.map((v) => ({ name: v.name, table_type: "view", row_count: null, sql: v.ddl })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  },

  // An unknown table is an empty list, not an error: `PRAGMA table_info` on a
  // missing table simply returns no rows.
  sqlite_get_columns: ({ connectionId, table: name }: Args): SqliteColumnInfo[] => {
    session(connectionId);
    return table(String(name))?.columns ?? [];
  },

  sqlite_get_indexes: ({ connectionId, table: name }: Args): SqliteIndexInfo[] => {
    session(connectionId);
    return table(String(name))?.indexes ?? [];
  },

  // Like the pragma: an unknown table or a view has none.
  sqlite_get_foreign_keys: ({ connectionId, table: name }: Args): ForeignKeyInfo[] => {
    session(connectionId);
    return table(String(name))?.foreignKeys ?? [];
  },

  sqlite_get_table_ddl: ({ connectionId, table: name }: Args): string => {
    session(connectionId);
    // Tables only, as the inspector's `type='table'` filter has it: a view's
    // DDL comes from the listing instead.
    return TABLES.find((t) => t.name === String(name).toLowerCase())?.ddl
      ?? fail("Schema error: Query returned no rows");
  },
};
