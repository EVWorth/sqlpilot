import type { SqlValue } from "../lib/bindings";
import { isNumericLiteral, isNumericSqlType } from "../lib/sql-types";

// Types crossing the Tauri boundary are generated from Rust by tauri-specta
// (src/lib/bindings.ts, regenerate with `make bindings`). Re-exported here so
// existing imports keep working and the definitions cannot drift from Rust.
export type {
  AiConfig,
  AiMode,
  AiStatus,
  ColumnInfo,
  ColumnMeta,
  ConnectionEnvironment,
  ConnectionInfo,
  DatabaseInfo,
  IndexInfo,
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
export interface EditorTab {
  id: string;
  title: string;
  content: string;
  connectionId?: string;
  profileId?: string;
  database?: string;
  tableName?: string;
  routineName?: string;
  routineType?: string;
  type?: "query" | "structure" | "admin" | "compare" | "designer" | "routine";
  isDirty: boolean;
}

export type AiStreamEvent =
  | { type: "text_delta"; conversation_id: string; content: string }
  | { type: "intent"; conversation_id: string; intent: string }
  | {
    type: "tool_start";
    conversation_id: string;
    tool_name: string;
    tool_call_id: string;
    arguments?: Record<string, unknown>;
  }
  | {
    type: "tool_complete";
    conversation_id: string;
    tool_name: string;
    tool_call_id: string;
    result: string;
    success: boolean;
  }
  | { type: "permission_request"; conversation_id: string; tool_name: string; description: string; request_id: string }
  | { type: "idle"; conversation_id: string }
  | { type: "error"; conversation_id: string; message: string };

export interface ToolExecution {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  arguments?: Record<string, unknown>;
  result?: string;
}

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tool"; tool: ToolExecution }
  | { type: "intent"; intent: string };

export interface PendingPermission {
  requestId: string;
  toolName: string;
  description: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  segments?: MessageSegment[];
  toolCalls?: ToolExecution[];
}

export interface Conversation {
  id: string;
  messages: ChatMessage[];
  title: string;
  createdAt: string;
}
