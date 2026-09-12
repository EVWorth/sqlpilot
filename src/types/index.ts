import type { SqlValue } from "../lib/bindings";
import { isNumericLiteral, isNumericSqlType } from "../lib/sql-types";

// Types crossing the Tauri boundary are generated from Rust by tauri-specta
// (src/lib/bindings.ts, regenerate with `make bindings`). Re-exported here so
// existing imports keep working and the definitions cannot drift from Rust.
export type {
  ColumnInfo,
  ColumnMeta,
  ConnectionEnvironment,
  ConnectionInfo,
  DatabaseInfo,
  EventInfo,
  ForeignKeyInfo,
  IndexInfo,
  PartitionInfo,
  ProcessInfo,
  RoutineInfo,
  ServerVariable,
  SqliteColumnInfo,
  SqliteColumnMeta,
  SqliteIndexInfo,
  SqliteQueryResult,
  SqliteTableInfo,
  SqlValue,
  SSLConfig,
  TableInfo,
  TestConnectionResult,
  TriggerInfo,
  ViewInfo,
} from "../lib/bindings";

// Phase-split: Rust marks some fields #[serde(skip_serializing)], so what the
// backend returns differs from what it accepts. These alias the _Serialize
// phase — the shape you get back — since that is what consumers handle. Code
// building one to *send* should import the _Deserialize form from ../lib/bindings.
export type { QueryResult_Serialize as QueryResult } from "../lib/bindings";

// Connection profiles are read and written in different shapes, because Rust
// marks password / passphrase #[serde(skip_serializing)]: the backend accepts
// them but never sends them back.
//
//   ConnectionProfile       — what you get back. No credentials, so reaching
//                             for `.password` on one is a compile error.
//   ConnectionProfileInput  — what you send. Carries credentials.
//
// Use the plain name unless you are actually building a profile to save.
export type {
  ConnectionProfile_Deserialize as ConnectionProfileInput,
  ConnectionProfile_Serialize as ConnectionProfile,
  ConnectionProfileSummary_Serialize as ConnectionProfileSummary,
  SSHConfig_Deserialize as SSHConfigInput,
  SSHConfig_Serialize as SSHConfig,
} from "../lib/bindings";

// Type guards and validators for SqlValue
function isNull(val: unknown): val is null {
  return val === null;
}

function isBoolean(val: unknown): val is boolean {
  return typeof val === "boolean";
}

function isNumber(val: unknown): val is number {
  return typeof val === "number" && !isNaN(val) && isFinite(val);
}

function isString(val: unknown): val is string {
  return typeof val === "string";
}

function isNumberArray(val: unknown): val is number[] {
  return Array.isArray(val) && val.every(v => typeof v === "number" && !isNaN(v) && isFinite(v));
}

function isValid(val: unknown): val is SqlValue {
  return (
    isNull(val)
    || isBoolean(val)
    || isNumber(val)
    || isString(val)
    || isNumberArray(val)
  );
}

function assert(val: unknown): SqlValue {
  if (isValid(val)) {
    return val;
  }
  throw new TypeError(`Invalid SqlValue: ${String(val)}`);
}

function toStr(val: SqlValue): string {
  if (val === null) return "NULL";
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return JSON.stringify(val);
  const _exhaustive: never = val;
  return String(_exhaustive);
}

/**
 * Render a cell as a SQL literal.
 *
 * `dataType` is needed because BIGINT and DECIMAL are carried as strings to
 * survive JSON, so a value's JavaScript type no longer says whether it is a
 * number. Given the column type, a numeric-looking string is emitted unquoted.
 */
function toSqlLiteral(val: SqlValue, dataType?: string): string {
  if (val === null) return "NULL";
  if (typeof val === "boolean") return val ? "1" : "0";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") {
    // Both conditions matter: the column must claim to be numeric and the text
    // must actually be one, or arbitrary text could land in SQL unquoted.
    if (isNumericSqlType(dataType) && isNumericLiteral(val)) return val;
    return `'${val.replace(/'/g, "''")}'`;
  }
  if (Array.isArray(val)) return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
  const _exhaustive: never = val;
  return String(_exhaustive);
}

export const SqlValueGuard = {
  isNull,
  isBoolean,
  isNumber,
  isString,
  isNumberArray,
  isValid,
  assert,
  toString: toStr,
  toSqlLiteral,
} as const;

// Editor types
/** What a routine tab is showing. The server has no third kind. */
export type RoutineKind = "PROCEDURE" | "FUNCTION";

/** Fields every tab has, whatever it shows. */
interface EditorTabBase {
  id: string;
  title: string;
  content: string;
  isDirty: boolean;
  /** Absent until the user picks a connection for the tab. */
  connectionId?: string;
  profileId?: string;
  database?: string;
}

/**
 * An editor tab, by kind.
 *
 * This was one flat interface with eight optional fields, so nothing could
 * tell a structure tab from a routine tab whose fields had not been filled in
 * yet — every consumer re-checked them, and `routineType` was typed as a bare
 * string, which is why MainPanel narrowed it back to PROCEDURE or FUNCTION
 * with a fallback that could never fire (#449).
 *
 * Narrowing on `type` now tells the compiler what is present. The fields a
 * kind requires are required on that kind, and absent from the others.
 */
export type EditorTab =
  | (EditorTabBase & { type: "query" })
  | (EditorTabBase & {
    type: "structure";
    connectionId: string;
    database: string;
    tableName: string;
  })
  | (EditorTabBase & { type: "admin"; connectionId: string })
  | (EditorTabBase & {
    type: "designer";
    connectionId: string;
    database: string;
    /** Absent when designing a new table rather than editing one. */
    tableName?: string;
  })
  | (EditorTabBase & {
    type: "routine";
    connectionId: string;
    database: string;
    routineName: string;
    routineType: RoutineKind;
  });
