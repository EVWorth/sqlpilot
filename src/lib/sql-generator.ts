import type { ColumnMeta } from "../types";

export function formatSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `X'${value.map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  const str = String(value);
  return `'${str.replace(/'/g, "''")}'`;
}

function buildWhereClause(
  pkColumns: string[],
  row: Record<string, unknown>,
): string {
  return pkColumns
    .map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return `\`${col}\` IS NULL`;
      return `\`${col}\` = ${formatSqlValue(val)}`;
    })
    .join(" AND ");
}

export function generateUpdate(
  tableName: string,
  pkColumns: string[],
  originalRow: Record<string, unknown>,
  changes: { column: string; newValue: unknown }[],
): string {
  const setClauses = changes
    .map((c) => `\`${c.column}\` = ${formatSqlValue(c.newValue)}`)
    .join(", ");
  const where = buildWhereClause(pkColumns, originalRow);
  return `UPDATE \`${tableName}\` SET ${setClauses} WHERE ${where} LIMIT 1;`;
}

export function generateInsert(
  tableName: string,
  columns: string[],
  row: Record<string, unknown>,
): string {
  const cols = columns.filter((c) => row[c] !== undefined);
  const colList = cols.map((c) => `\`${c}\``).join(", ");
  const valList = cols.map((c) => formatSqlValue(row[c])).join(", ");
  return `INSERT INTO \`${tableName}\` (${colList}) VALUES (${valList});`;
}

export function generateDelete(
  tableName: string,
  pkColumns: string[],
  row: Record<string, unknown>,
): string {
  const where = buildWhereClause(pkColumns, row);
  return `DELETE FROM \`${tableName}\` WHERE ${where} LIMIT 1;`;
}

const TABLE_NAME_RE = /\bFROM\s+(?:`([^`]+)`|(\w+))(?:\s|;|$)/i;

export function extractTableName(sql: string): string | null {
  const match = TABLE_NAME_RE.exec(sql);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

export function getPrimaryKeyColumns(columns: ColumnMeta[]): string[] {
  return columns.filter((c) => c.is_primary_key).map((c) => c.name);
}

export function getWhereColumns(columns: ColumnMeta[]): {
  columns: string[];
  hasPrimaryKey: boolean;
} {
  const pk = getPrimaryKeyColumns(columns);
  if (pk.length > 0) return { columns: pk, hasPrimaryKey: true };
  return { columns: columns.map((c) => c.name), hasPrimaryKey: false };
}
