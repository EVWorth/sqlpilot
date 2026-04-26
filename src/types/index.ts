// Connection types
export type ConnectionEnvironment = "development" | "staging" | "production";

export interface ConnectionProfile {
  id: string;
  name: string;
  group?: string;
  color?: string;
  environment?: ConnectionEnvironment;
  host: string;
  port: number;
  username: string;
  password?: string;
  default_database?: string;
  ssh_config?: SSHConfig;
  ssl_config?: SSLConfig;
  pool_min: number;
  pool_max: number;
  read_only: boolean;
  created_at: string;
  updated_at: string;
}

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  private_key_path?: string;
  passphrase?: string;
}

export interface SSLConfig {
  mode: "Disabled" | "Preferred" | "Required" | "VerifyCA" | "VerifyIdentity";
  ca_cert_path?: string;
  client_cert_path?: string;
  client_key_path?: string;
}

export interface ConnectionInfo {
  id: string;
  profile_id: string;
  name: string;
  host: string;
  port: number;
  database?: string;
  server_version: string;
  connected_at: string;
  color?: string;
  environment?: ConnectionEnvironment;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  server_version?: string;
  latency_ms: number;
}

// Query types
export interface QueryResult {
  query_id: string;
  statement_index: number;
  columns: ColumnMeta[];
  rows: SqlValue[][];
  rows_affected: number;
  execution_time_ms: number;
  warnings: string[];
  rows_truncated: boolean;
  total_rows_available?: number;
}

export interface ColumnMeta {
  name: string;
  data_type: string;
  nullable: boolean;
  is_primary_key: boolean;
}

export type SqlValue = null | boolean | number | string | number[];

// Schema types
export interface DatabaseInfo {
  name: string;
  default_charset: string;
  default_collation: string;
}

export interface TableInfo {
  name: string;
  table_type: string;
  engine?: string;
  row_count?: number;
  data_size?: number;
  comment: string;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  column_type: string;
  nullable: boolean;
  default_value?: string;
  is_primary_key: boolean;
  extra: string;
  comment: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  is_unique: boolean;
  index_type: string;
}

export interface ViewInfo {
  name: string;
  is_updatable: boolean;
}

export interface RoutineInfo {
  name: string;
  routine_type: string;
  data_type: string;
}

export interface TriggerInfo {
  name: string;
  event: string;
  table: string;
  timing: string;
}

// Admin types
export interface ProcessInfo {
  id: number;
  user: string;
  host: string;
  db?: string;
  command: string;
  time: number;
  state?: string;
  info?: string;
}

export interface ServerVariable {
  name: string;
  value: string;
}

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
  type?: "query" | "structure" | "admin" | "compare" | "designer" | "routine" | "querybuilder";
  isDirty: boolean;
}

// AI types
export type AiMode = "ask" | "agent" | "plan";

export interface AiStatus {
  provider: string;
  available: boolean;
  model?: string;
}

export interface AiConfig {
  model?: string;
}

export type AiStreamEvent =
  | { type: "text_delta"; conversation_id: string; content: string }
  | { type: "intent"; conversation_id: string; intent: string }
  | { type: "tool_start"; conversation_id: string; tool_name: string; tool_call_id: string; arguments?: Record<string, unknown> }
  | { type: "tool_complete"; conversation_id: string; tool_name: string; tool_call_id: string; result: string; success: boolean }
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
