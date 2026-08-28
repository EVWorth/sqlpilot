import type { ColumnMeta } from "../types";
import { isNumericLiteral, isNumericSqlType } from "./sql-types";

/** Column name -> declared SQL type, for values whose JS type is not enough. */
export type ColumnTypes = Record<string, string>;

export function columnTypesOf(columns: ColumnMeta[]): ColumnTypes {
  return Object.fromEntries(columns.map((c) => [c.name, c.data_type]));
}

/**
 * Render a value as a SQL literal.
 *
 * `dataType` matters because BIGINT and DECIMAL travel as strings to survive
 * JSON, so `typeof value === "number"` no longer identifies a number. Without
 * it a BIGINT id is emitted as `'9007199254740993'` — quoted, when it should
 * not be.
 */
export function formatSqlValue(value: unknown, dataType?: string): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `X'${value.map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  const str = String(value);
  // Unquote only when the column says numeric *and* the text really is a
  // number — trusting the type alone would splice unquoted text into SQL if
  // the two ever disagreed.
  if (isNumericSqlType(dataType) && isNumericLiteral(str)) return str;
  return `'${str.replace(/'/g, "''")}'`;
}

function buildWhereClause(
  pkColumns: string[],
  row: Record<string, unknown>,
  types?: ColumnTypes,
): string {
  return pkColumns
    .map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return `\`${col}\` IS NULL`;
      return `\`${col}\` = ${formatSqlValue(val, types?.[col])}`;
    })
    .join(" AND ");
}

export function generateUpdate(
  tableName: string,
  pkColumns: string[],
  originalRow: Record<string, unknown>,
  changes: { column: string; newValue: unknown }[],
  types?: ColumnTypes,
): string {
  const setClauses = changes
    .map((c) => `\`${c.column}\` = ${formatSqlValue(c.newValue, types?.[c.column])}`)
    .join(", ");
  const where = buildWhereClause(pkColumns, originalRow, types);
  return `UPDATE \`${tableName}\` SET ${setClauses} WHERE ${where} LIMIT 1;`;
}

export function generateInsert(
  tableName: string,
  columns: string[],
  row: Record<string, unknown>,
  types?: ColumnTypes,
): string {
  const cols = columns.filter((c) => row[c] !== undefined);
  const colList = cols.map((c) => `\`${c}\``).join(", ");
  const valList = cols.map((c) => formatSqlValue(row[c], types?.[c])).join(", ");
  return `INSERT INTO \`${tableName}\` (${colList}) VALUES (${valList});`;
}

export function generateDelete(
  tableName: string,
  pkColumns: string[],
  row: Record<string, unknown>,
  types?: ColumnTypes,
): string {
  const where = buildWhereClause(pkColumns, row, types);
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
