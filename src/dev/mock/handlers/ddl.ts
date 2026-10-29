// Schema writes: CREATE, ALTER, RENAME and DROP change the fixture, so a read
// after them (the tree's refresh, the structure panel, the designer reopening
// a table) shows the change, as it would on a server.
//
// Only the shapes SQLPilot writes and a person commonly types are understood:
// the designer's single ALTER TABLE with every clause, CREATE TABLE with
// column, key and foreign key definitions, CREATE and DROP INDEX, RENAME
// TABLE, DROP TABLE and CREATE/DROP DATABASE. Each runs all-or-nothing, as an
// ALTER does on the server: a clause that fails leaves the table untouched.
// Rows are not stored, so a new column reads as its default in every row.
//
// The server's errors for the usual mistakes come back with their codes: an
// empty or malformed definition list is 1064, a table that exists 1050, an
// unknown one 1146, a duplicate column 1060, a duplicate key 1061, dropping
// what is not there 1091.

import type { ForeignKeyInfo, SqlValue } from "../../../lib/bindings";
import { DATABASES, type MockColumn, type MockDatabase, type MockTable } from "../dataset";
import { FOREIGN_KEYS, INDEXES, type IndexSpec, indexSpecs, key } from "./schema";

/** A server error, as the statement's caller reports it. */
export class DdlError {
  constructor(readonly code: number, readonly sqlState: string, readonly message: string) {}
}

const syntax = (near: string, server: string): never => {
  throw new DdlError(
    1064,
    "42000",
    `You have an error in your SQL syntax; check the manual that corresponds to your ${server} server version `
      + `for the right syntax to use near '${near.slice(0, 80)}' at line 1`,
  );
};
const error = (code: number, sqlState: string, message: string): never => {
  throw new DdlError(code, sqlState, message);
};

// ---------------------------------------------------------------- text

const IDENT = String.raw`(?:\x60(?:[^\x60]|\x60\x60)+\x60|[A-Za-z_$][\w$]*)`;
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
const unquote = (s: string) => {
  const t = s.trim();
  return t.startsWith("`") ? t.slice(1, -1).replace(/``/g, "`") : t;
};
const nameList = (s: string) =>
  splitTopLevel(s).map((c) => unquote(c.replace(/\s*\(\d+\)\s*$/, "").replace(/\s+(asc|desc)$/i, "")));

/** Split on commas outside parentheses and quotes. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === "\"" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts;
}

/** The text inside the parentheses that open at `from`, and where they close. */
function parenthesised(s: string, from: number): { inner: string; end: number } | undefined {
  if (s[from] !== "(") return undefined;
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === "\"" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { inner: s.slice(from + 1, i), end: i + 1 };
  }
  return undefined;
}

// ---------------------------------------------------------------- columns

const TYPES = new Set([
  ...["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric", "float", "double"],
  ...["bit", "bool", "boolean", "date", "datetime", "timestamp", "time", "year", "char", "varchar"],
  ...["binary", "varbinary", "tinytext", "text", "mediumtext", "longtext", "tinyblob", "blob"],
  ...["mediumblob", "longblob", "enum", "set", "json", "geometry", "point", "uuid", "inet4", "inet6"],
]);

const NUMERIC = /^(tiny|small|medium|big)?int|^integer|^decimal|^numeric|^float|^double|^bit|^bool/;

function literal(raw: string): string {
  const q = /^'((?:[^']|'')*)'$|^"((?:[^"]|"")*)"$/.exec(raw);
  return q ? (q[1] ?? q[2]).replace(/''|""/g, (x) => x[0]) : raw;
}

/** A column definition, `` `name` VARCHAR(64) NOT NULL DEFAULT 'x' COMMENT '…' ``. */
function parseColumn(
  def: string,
  server: string,
  keep?: MockColumn,
): { column: MockColumn; primary: boolean; unique: boolean } {
  const head = new RegExp(`^(${IDENT})\\s+([A-Za-z]+)\\s*`).exec(def);
  if (!head) return syntax(def, server);
  const name = unquote(head[1]);
  const base = head[2].toLowerCase();
  if (!TYPES.has(base)) return syntax(def.slice(head[1].length).trim(), server);
  let rest = def.slice(head[0].length);
  let args = "";
  const p = parenthesised(rest, 0);
  if (p) {
    args = p.inner.replace(/\s+/g, "");
    rest = rest.slice(p.end).trim();
  }
  const words = rest;
  const unsigned = /\bunsigned\b/i.test(words);
  const zerofill = /\bzerofill\b/i.test(words);
  const dataType = base === "integer" ? "int" : base === "bool" || base === "boolean" ? "tinyint" : base;
  // The type name in lower case, as information_schema has it; the arguments
  // as written, since ENUM values are case-sensitive.
  const typeArgs = base === "bool" || base === "boolean"
    ? "(1)"
    : args
    ? `(${(p?.inner ?? "").trim().replace(/\s*,\s*/g, ",")})`
    : "";
  const columnType = `${dataType}${typeArgs}${unsigned || zerofill ? " unsigned" : ""}${zerofill ? " zerofill" : ""}`;

  const defaultMatch = /\bdefault\s+('(?:[^']|'')*'|"(?:[^"]|"")*"|\([^)]*\)|[\w.()+-]+)/i.exec(words);
  const defaultRaw = defaultMatch?.[1];
  const defaultValue = defaultRaw === undefined || /^null$/i.test(defaultRaw) ? null : literal(defaultRaw);
  const expression = defaultRaw !== undefined && /^(current_timestamp|now\(|\()/i.test(defaultRaw);
  const onUpdate = /\bon\s+update\s+([\w()]+)/i.exec(words)?.[1];
  const auto = /\bauto_increment\b/i.test(words);
  const primary = /\bprimary\s+key\b/i.test(words);
  const comment = /\bcomment\s+'((?:[^']|'')*)'/i.exec(words)?.[1]?.replace(/''/g, "'") ?? "";
  const nullable = !/\bnot\s+null\b/i.test(words) && !primary;
  const extra = [
    auto ? "auto_increment" : "",
    expression ? "DEFAULT_GENERATED" : "",
    onUpdate ? `on update ${onUpdate.toUpperCase()}` : "",
  ].filter(Boolean).join(" ");

  const numeric = NUMERIC.test(dataType);
  const fallback: SqlValue = defaultValue !== null && !expression
    ? (numeric && !Number.isNaN(Number(defaultValue)) ? Number(defaultValue) : defaultValue)
    : nullable
    ? null
    : numeric
    ? 0
    : "";
  return {
    column: {
      name,
      data_type: dataType,
      column_type: columnType,
      nullable,
      default_value: expression ? (defaultRaw ?? null) : defaultValue,
      is_primary_key: primary,
      extra,
      comment,
      charset: /\bcharacter\s+set\s+(\w+)/i.exec(words)?.[1] ?? null,
      collation: /\bcollate\s+(\w+)/i.exec(words)?.[1] ?? null,
      // A column that existed keeps its rows; a new one reads as its default.
      gen: keep?.gen ?? (auto ? (i) => i + 1 : () => fallback),
    },
    primary,
    unique: /\bunique\b/i.test(words),
  };
}

// ---------------------------------------------------------------- keys

type KeyDef =
  | { kind: "primary"; columns: string[] }
  | { kind: "index"; name: string | null; unique: boolean; columns: string[] }
  | { kind: "foreign"; fk: Omit<ForeignKeyInfo, "name"> & { name: string | null } };

/** A key definition, or undefined when the text is a column instead. */
function parseKey(def: string, server: string): KeyDef | undefined {
  const pk = /^(?:constraint\s+(?:\S+\s+)?)?primary\s+key\s*(?:using\s+\w+\s*)?\(([\s\S]+)\)$/i.exec(def);
  if (pk) return { kind: "primary", columns: nameList(pk[1]) };
  const idx = new RegExp(
    `^(?:constraint\\s+(?:${IDENT}\\s+)?)?(unique|fulltext|spatial)?\\s*(?:index|key)?\\s*(${IDENT})?\\s*\\(([\\s\\S]+)\\)$`,
    "i",
  ).exec(def);
  if (idx && /^(unique|fulltext|spatial|index|key|constraint)\b/i.test(def)) {
    return {
      kind: "index",
      name: idx[2] ? unquote(idx[2]) : null,
      unique: /^unique$/i.test(idx[1] ?? ""),
      columns: nameList(idx[3]),
    };
  }
  const fk = new RegExp(
    `^(?:constraint\\s+(${IDENT})\\s+)?foreign\\s+key\\s*(?:${IDENT}\\s*)?\\(([^)]+)\\)\\s*references\\s+(${QUALIFIED})\\s*\\(([^)]+)\\)([\\s\\S]*)$`,
    "i",
  ).exec(def);
  if (fk) {
    const rule = (what: string) =>
      (new RegExp(`\\bon\\s+${what}\\s+(restrict|cascade|set\\s+null|no\\s+action|set\\s+default)`, "i").exec(fk[5])
        ?.[1]
        ?? "NO ACTION").toUpperCase().replace(/\s+/g, " ");
    return {
      kind: "foreign",
      fk: {
        name: fk[1] ? unquote(fk[1]) : null,
        columns: nameList(fk[2]),
        referenced_table: unquote(fk[3].split(".").pop() ?? fk[3]),
        referenced_columns: nameList(fk[4]),
        on_delete: rule("delete"),
        on_update: rule("update"),
      },
    };
  }
  if (/^(constraint|primary|unique|index|key|foreign|fulltext|spatial|check)\b/i.test(def)) {
    // CHECK constraints are accepted and not modelled; anything else here is broken.
    if (/^(constraint\s+\S+\s+)?check\s*\(/i.test(def)) {
      return { kind: "index", name: null, unique: false, columns: [] };
    }
    return syntax(def, server);
  }
  return undefined;
}

// ---------------------------------------------------------------- the working copy

/** A table being changed, applied to the fixture only if every clause works. */
interface Draft {
  name: string;
  engine: string | null;
  comment: string;
  columns: MockColumn[];
  indexes: IndexSpec[];
  fks: ForeignKeyInfo[];
}

function draftOf(db: string, table: MockTable): Draft {
  return {
    name: table.name,
    engine: table.engine,
    comment: table.comment,
    columns: [...table.columns],
    indexes: indexSpecs(db, table).map((i) => ({ ...i, columns: [...i.columns] })),
    fks: (FOREIGN_KEYS[key(db, table.name)] ?? []).map((f) => ({ ...f })),
  };
}

function commit(db: MockDatabase, table: MockTable, draft: Draft): void {
  const pk = draft.indexes.find((i) => i.name === "PRIMARY")?.columns ?? [];
  const columns = draft.columns.map((c) => ({ ...c, is_primary_key: pk.includes(c.name) }));
  delete INDEXES[key(db.name, table.name)];
  delete FOREIGN_KEYS[key(db.name, table.name)];
  Object.assign(table, { name: draft.name, engine: draft.engine, comment: draft.comment, columns });
  INDEXES[key(db.name, draft.name)] = draft.indexes;
  if (draft.fks.length) FOREIGN_KEYS[key(db.name, draft.name)] = draft.fks;
}

const hasColumn = (d: Draft, name: string) => d.columns.some((c) => c.name.toLowerCase() === name.toLowerCase());

function requireColumns(d: Draft, cols: string[]): void {
  const missing = cols.find((c) => !hasColumn(d, c));
  if (missing) error(1072, "42000", `Key column '${missing}' doesn't exist in table`);
}

function addKey(d: Draft, k: KeyDef): void {
  if (k.kind === "primary") {
    if (d.indexes.some((i) => i.name === "PRIMARY")) error(1068, "42000", "Multiple primary key defined");
    requireColumns(d, k.columns);
    d.indexes.push({ name: "PRIMARY", columns: k.columns, unique: true });
  } else if (k.kind === "index") {
    if (k.columns.length === 0) return;
    requireColumns(d, k.columns);
    let name = k.name ?? k.columns[0];
    // An unnamed key takes its first column's name, numbered if that is taken.
    for (let n = 2; !k.name && d.indexes.some((i) => i.name === name); n++) name = `${k.columns[0]}_${n}`;
    if (d.indexes.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
      error(1061, "42000", `Duplicate key name '${name}'`);
    }
    d.indexes.push({ name, columns: k.columns, unique: k.unique });
  } else {
    requireColumns(d, k.fk.columns);
    const name = k.fk.name ?? `${d.name}_ibfk_${d.fks.length + 1}`;
    if (d.fks.some((f) => f.name === name)) error(1826, "HY000", `Duplicate foreign key constraint name '${name}'`);
    d.fks.push({ ...k.fk, name });
    // MySQL adds an index for the referencing columns if none starts with them.
    if (!d.indexes.some((i) => i.columns[0] === k.fk.columns[0])) {
      d.indexes.push({ name, columns: k.fk.columns, unique: false });
    }
  }
}

function placeColumn(d: Draft, column: MockColumn, position: string | undefined, replacing?: string): void {
  if (replacing !== undefined) {
    const at = d.columns.findIndex((c) => c.name.toLowerCase() === replacing.toLowerCase());
    d.columns.splice(at, 1);
    if (!position) {
      d.columns.splice(at, 0, column);
      return;
    }
  }
  if (!position) {
    d.columns.push(column);
  } else if (/^first$/i.test(position)) {
    d.columns.unshift(column);
  } else {
    const after = unquote(position.replace(/^after\s+/i, ""));
    const at = d.columns.findIndex((c) => c.name.toLowerCase() === after.toLowerCase());
    if (at < 0) error(1054, "42S22", `Unknown column '${after}' in '${d.name}'`);
    d.columns.splice(at + 1, 0, column);
  }
}

function renameInKeys(d: Draft, from: string, to: string): void {
  const swap = (cols: string[]) => cols.map((c) => (c === from ? to : c));
  d.indexes = d.indexes.map((i) => ({ ...i, columns: swap(i.columns) }));
  d.fks = d.fks.map((f) => ({ ...f, columns: swap(f.columns) }));
}

function dropColumn(d: Draft, name: string): void {
  if (!hasColumn(d, name)) error(1091, "42000", `Can't DROP '${name}'; check that column/key exists`);
  if (d.columns.length === 1) {
    error(1090, "42000", "You can't delete all columns with ALTER TABLE; use DROP TABLE instead");
  }
  d.columns = d.columns.filter((c) => c.name.toLowerCase() !== name.toLowerCase());
  // Keys lose the column; a key left with none goes with it.
  d.indexes = d.indexes
    .map((i) => ({ ...i, columns: i.columns.filter((c) => c.toLowerCase() !== name.toLowerCase()) }))
    .filter((i) => i.columns.length > 0);
}

const POSITION = /\s+(first|after\s+\S+)\s*$/i;

/** One clause of an ALTER TABLE, applied to the draft. */
function alterClause(d: Draft, clause: string, server: string): void {
  let m: RegExpExecArray | null;
  const c = clause.trim();
  if ((m = /^add\s+(?!column\b)(.+)$/is.exec(c))) {
    const k = parseKey(m[1].trim(), server);
    if (k) return addKey(d, k);
  }
  if ((m = /^add\s+(?:column\s+)?(.+)$/is.exec(c))) {
    const body = m[1].trim();
    if (body.startsWith("(")) {
      for (const def of splitTopLevel(parenthesised(body, 0)?.inner ?? "")) alterClause(d, `ADD COLUMN ${def}`, server);
      return;
    }
    const position = POSITION.exec(body)?.[1];
    const { column, primary, unique } = parseColumn(position ? body.replace(POSITION, "") : body, server);
    if (hasColumn(d, column.name)) error(1060, "42S21", `Duplicate column name '${column.name}'`);
    placeColumn(d, column, position);
    if (primary) addKey(d, { kind: "primary", columns: [column.name] });
    if (unique) addKey(d, { kind: "index", name: column.name, unique: true, columns: [column.name] });
    return;
  }
  if (/^drop\s+primary\s+key$/i.test(c)) {
    if (!d.indexes.some((i) => i.name === "PRIMARY")) {
      error(1091, "42000", "Can't DROP 'PRIMARY'; check that column/key exists");
    }
    d.indexes = d.indexes.filter((i) => i.name !== "PRIMARY");
    return;
  }
  if ((m = new RegExp(`^drop\\s+(?:index|key)\\s+(${IDENT})$`, "i").exec(c))) {
    const name = unquote(m[1]);
    if (!d.indexes.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
      error(1091, "42000", `Can't DROP '${name}'; check that column/key exists`);
    }
    d.indexes = d.indexes.filter((i) => i.name.toLowerCase() !== name.toLowerCase());
    return;
  }
  if ((m = new RegExp(`^drop\\s+(?:foreign\\s+key|constraint)\\s+(${IDENT})$`, "i").exec(c))) {
    const name = unquote(m[1]);
    if (!d.fks.some((f) => f.name === name)) error(1091, "42000", `Can't DROP '${name}'; check that column/key exists`);
    d.fks = d.fks.filter((f) => f.name !== name);
    return;
  }
  if ((m = new RegExp(`^drop\\s+(?:column\\s+)?(${IDENT})$`, "i").exec(c))) return dropColumn(d, unquote(m[1]));
  if ((m = /^modify\s+(?:column\s+)?(.+)$/is.exec(c))) {
    const body = m[1].trim();
    const position = POSITION.exec(body)?.[1];
    const name = unquote(new RegExp(`^${IDENT}`).exec(body)?.[0] ?? "");
    const old = d.columns.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!old) return error(1054, "42S22", `Unknown column '${name}' in '${d.name}'`);
    placeColumn(d, parseColumn(position ? body.replace(POSITION, "") : body, server, old).column, position, old.name);
    return;
  }
  if ((m = new RegExp(`^change\\s+(?:column\\s+)?(${IDENT})\\s+(.+)$`, "is").exec(c))) {
    const from = unquote(m[1]);
    const body = m[2].trim();
    const position = POSITION.exec(body)?.[1];
    const old = d.columns.find((x) => x.name.toLowerCase() === from.toLowerCase());
    if (!old) return error(1054, "42S22", `Unknown column '${from}' in '${d.name}'`);
    const { column } = parseColumn(position ? body.replace(POSITION, "") : body, server, old);
    if (column.name.toLowerCase() !== from.toLowerCase() && hasColumn(d, column.name)) {
      error(1060, "42S21", `Duplicate column name '${column.name}'`);
    }
    placeColumn(d, column, position, old.name);
    renameInKeys(d, old.name, column.name);
    return;
  }
  if ((m = new RegExp(`^rename\\s+column\\s+(${IDENT})\\s+to\\s+(${IDENT})$`, "i").exec(c))) {
    const from = unquote(m[1]);
    const to = unquote(m[2]);
    const at = d.columns.findIndex((x) => x.name.toLowerCase() === from.toLowerCase());
    if (at < 0) error(1054, "42S22", `Unknown column '${from}' in '${d.name}'`);
    d.columns[at] = { ...d.columns[at], name: to };
    renameInKeys(d, from, to);
    return;
  }
  if ((m = new RegExp(`^rename\\s+(?:index|key)\\s+(${IDENT})\\s+to\\s+(${IDENT})$`, "i").exec(c))) {
    const from = unquote(m[1]);
    const idx = d.indexes.find((i) => i.name === from);
    if (!idx) return error(1176, "42000", `Key '${from}' doesn't exist in table '${d.name}'`);
    idx.name = unquote(m[2]);
    return;
  }
  if ((m = new RegExp(`^rename\\s+(?:to\\s+|as\\s+)?(${QUALIFIED})$`, "i").exec(c))) {
    d.name = unquote(m[1].split(/\s*\.\s*/).pop() ?? m[1]);
    return;
  }
  if ((m = /^engine\s*=?\s*(\w+)$/i.exec(c))) {
    d.engine = m[1];
    return;
  }
  if ((m = /^comment\s*=?\s*'((?:[^']|'')*)'$/i.exec(c))) {
    d.comment = m[1].replace(/''/g, "'");
    return;
  }
  // Options the fixture does not show differently.
  if (
    /^(default\s+)?(charset|character\s+set|collate|auto_increment|row_format|algorithm|lock|convert\s+to|force)\b/i
      .test(c)
  ) {
    return;
  }
  syntax(c, server);
}

// ---------------------------------------------------------------- statements

function findDb(name: string): MockDatabase | undefined {
  return DATABASES.find((d) => d.name.toLowerCase() === name.toLowerCase());
}

/** `db.table` or `table` against the default database. */
function resolve(raw: string, defaultDb: string | null): { db: MockDatabase; name: string } {
  const parts = raw.split(/\s*\.\s*/).map(unquote);
  const name = parts[parts.length - 1];
  const dbName = parts.length > 1 ? parts[0] : defaultDb;
  if (!dbName) return error(1046, "3D000", "No database selected");
  const db = findDb(dbName) ?? error(1049, "42000", `Unknown database '${dbName}'`);
  return { db, name };
}

const tableIn = (db: MockDatabase, name: string) => db.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());

function createTable(clean: string, defaultDb: string | null, server: string): void {
  const head = new RegExp(`^create\\s+(?:temporary\\s+)?table\\s+(if\\s+not\\s+exists\\s+)?(${QUALIFIED})\\s*`, "i")
    .exec(clean);
  if (!head) return syntax(clean.replace(/^create\s+(temporary\s+)?table\s*/i, ""), server);
  const { db, name } = resolve(head[2], defaultDb);
  const rest = clean.slice(head[0].length);
  // CREATE TABLE ... LIKE / AS SELECT: accepted, not modelled.
  if (!rest.startsWith("(")) {
    if (/^(like\b|as\b|select\b|\()/i.test(rest)) return;
    return syntax(rest, server);
  }
  const body = parenthesised(rest, 0) ?? syntax(rest, server);
  const defs = splitTopLevel(body.inner);
  // `CREATE TABLE orders ()`: the parser wants at least one definition, and
  // says so before it looks at whether the table exists.
  if (defs.some((d) => d === "")) return syntax(`${body.inner.trim() ? "," : ")"}${rest.slice(body.end)}`, server);
  if (tableIn(db, name)) {
    if (head[1]) return;
    return error(1050, "42S01", `Table '${name}' already exists`);
  }

  const draft: Draft = { name, engine: "InnoDB", comment: "", columns: [], indexes: [], fks: [] };
  const keys: KeyDef[] = [];
  for (const def of defs) {
    const k = parseKey(def, server);
    if (k) {
      keys.push(k);
      continue;
    }
    const { column, primary, unique } = parseColumn(def, server);
    if (hasColumn(draft, column.name)) error(1060, "42S21", `Duplicate column name '${column.name}'`);
    draft.columns.push(column);
    if (primary) keys.push({ kind: "primary", columns: [column.name] });
    if (unique) keys.push({ kind: "index", name: column.name, unique: true, columns: [column.name] });
  }
  if (draft.columns.length === 0) error(1113, "42000", "A table must have at least 1 column");
  for (const k of keys) addKey(draft, k);
  const options = rest.slice(body.end);
  draft.engine = /\bengine\s*=?\s*(\w+)/i.exec(options)?.[1] ?? "InnoDB";
  draft.comment = /\bcomment\s*=?\s*'((?:[^']|'')*)'/i.exec(options)?.[1]?.replace(/''/g, "'") ?? "";

  const table: MockTable = { name, table_type: "BASE TABLE", engine: null, comment: "", columns: [], rowCount: 0 };
  db.tables.push(table);
  commit(db, table, draft);
}

function alterTable(clean: string, defaultDb: string | null, server: string): void {
  const head = new RegExp(`^alter\\s+(?:online\\s+|ignore\\s+)?table\\s+(${QUALIFIED})\\s*`, "i").exec(clean);
  if (!head) return syntax(clean, server);
  const { db, name } = resolve(head[1], defaultDb);
  const table = tableIn(db, name) ?? error(1146, "42S02", `Table '${db.name}.${name}' doesn't exist`);
  if (table.table_type === "VIEW") error(1347, "HY000", `'${db.name}.${table.name}' is not BASE TABLE`);
  const clauses = splitTopLevel(clean.slice(head[0].length));
  if (clauses.some((c) => c === "")) return syntax(clean.slice(head[0].length), server);
  const draft = draftOf(db.name, table);
  for (const clause of clauses) alterClause(draft, clause, server);
  if (draft.name.toLowerCase() !== table.name.toLowerCase() && tableIn(db, draft.name)) {
    error(1050, "42S01", `Table '${draft.name}' already exists`);
  }
  commit(db, table, draft);
}

function dropTable(clean: string, defaultDb: string | null, server: string): void {
  const m = /^drop\s+(?:temporary\s+)?(table|view)s?\s+(if\s+exists\s+)?([\s\S]+?)(?:\s+(?:restrict|cascade))?$/i.exec(
    clean,
  );
  if (!m) return syntax(clean, server);
  const targets = splitTopLevel(m[3]).map((t) => resolve(t, defaultDb));
  const missing = targets.filter((t) => !tableIn(t.db, t.name));
  if (missing.length && !m[2]) {
    error(1051, "42S02", `Unknown table '${missing.map((t) => `${t.db.name}.${t.name}`).join(",")}'`);
  }
  for (const { db, name } of targets) {
    db.tables = db.tables.filter((t) => t.name.toLowerCase() !== name.toLowerCase());
    delete INDEXES[key(db.name, name)];
    delete FOREIGN_KEYS[key(db.name, name)];
  }
}

function renameTable(clean: string, defaultDb: string | null, server: string): void {
  const pairs = splitTopLevel(clean.replace(/^rename\s+tables?\s+/i, ""));
  for (const pair of pairs) {
    const [from, to] = pair.split(/\s+to\s+/i);
    if (!from || !to) return syntax(pair, server);
    const a = resolve(from, defaultDb);
    const table = tableIn(a.db, a.name) ?? error(1146, "42S02", `Table '${a.db.name}.${a.name}' doesn't exist`);
    const b = resolve(to, defaultDb);
    if (tableIn(b.db, b.name)) error(1050, "42S01", `Table '${b.name}' already exists`);
    const draft = draftOf(a.db.name, table);
    draft.name = b.name;
    delete INDEXES[key(a.db.name, table.name)];
    delete FOREIGN_KEYS[key(a.db.name, table.name)];
    commit(b.db, table, draft);
    if (b.db !== a.db) {
      a.db.tables = a.db.tables.filter((t) => t !== table);
      b.db.tables.push(table);
    }
  }
}

function createIndex(clean: string, defaultDb: string | null, server: string): void {
  const m = new RegExp(
    `^create\\s+(unique\\s+|fulltext\\s+|spatial\\s+)?index\\s+(${IDENT})\\s+(?:using\\s+\\w+\\s+)?on\\s+(${QUALIFIED})\\s*\\(([\\s\\S]+)\\)`,
    "i",
  ).exec(clean);
  if (!m) return syntax(clean, server);
  const unique = /unique/i.test(m[1] ?? "");
  alterTable(`ALTER TABLE ${m[3]} ADD ${unique ? "UNIQUE " : ""}INDEX ${m[2]} (${m[4]})`, defaultDb, server);
}

function dropIndex(clean: string, defaultDb: string | null, server: string): void {
  const m = new RegExp(`^drop\\s+index\\s+(${IDENT})\\s+on\\s+(${QUALIFIED})`, "i").exec(clean);
  if (!m) return syntax(clean, server);
  alterTable(`ALTER TABLE ${m[2]} DROP INDEX ${m[1]}`, defaultDb, server);
}

function createDatabase(clean: string, server: string): void {
  const m = new RegExp(`^create\\s+(?:database|schema)\\s+(if\\s+not\\s+exists\\s+)?(${IDENT})`, "i").exec(clean);
  if (!m) return syntax(clean, server);
  const name = unquote(m[2]);
  if (findDb(name)) {
    if (m[1]) return;
    return error(1007, "HY000", `Can't create database '${name}'; database exists`);
  }
  DATABASES.push({ name, is_system: false, tables: [] });
  DATABASES.sort((a, b) => a.name.localeCompare(b.name));
}

function dropDatabase(clean: string, server: string): void {
  const m = new RegExp(`^drop\\s+(?:database|schema)\\s+(if\\s+exists\\s+)?(${IDENT})`, "i").exec(clean);
  if (!m) return syntax(clean, server);
  const name = unquote(m[2]);
  const db = findDb(name);
  if (!db) {
    if (m[1]) return;
    return error(1008, "HY000", `Can't drop database '${name}'; database doesn't exist`);
  }
  if (db.is_system) error(1044, "42000", `Access denied for user to database '${name}'`);
  DATABASES.splice(DATABASES.indexOf(db), 1);
}

/**
 * Apply a schema write to the fixture. Returns whether the statement was one;
 * throws a `DdlError` for one the server would refuse.
 *
 * `clean` is the statement with comments stripped and whitespace collapsed.
 */
export function applyDdl(clean: string, defaultDb: string | null, version: string): boolean {
  const server = version.toLowerCase().includes("mariadb") ? "MariaDB" : "MySQL";
  if (/^create\s+(temporary\s+)?table\b/i.test(clean)) createTable(clean, defaultDb, server);
  else if (/^alter\s+(online\s+|ignore\s+)?table\b/i.test(clean)) alterTable(clean, defaultDb, server);
  else if (/^drop\s+(temporary\s+)?tables?\b/i.test(clean)) dropTable(clean, defaultDb, server);
  else if (/^rename\s+tables?\b/i.test(clean)) renameTable(clean, defaultDb, server);
  else if (/^create\s+(unique\s+|fulltext\s+|spatial\s+)?index\b/i.test(clean)) createIndex(clean, defaultDb, server);
  else if (/^drop\s+index\b/i.test(clean)) dropIndex(clean, defaultDb, server);
  else if (/^create\s+(database|schema)\b/i.test(clean)) createDatabase(clean, server);
  else if (/^drop\s+(database|schema)\b/i.test(clean)) dropDatabase(clean, server);
  else return false;
  return true;
}
