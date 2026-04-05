import type { ColumnInfo } from "../types";

export type AggregateFunction = "COUNT" | "SUM" | "AVG" | "MAX" | "MIN";
export type JoinType = "INNER" | "LEFT" | "RIGHT";
export type WhereOperator =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "LIKE"
  | "IN"
  | "IS NULL"
  | "IS NOT NULL";
export type LogicOperator = "AND" | "OR";
export type SortDirection = "ASC" | "DESC";

export const WHERE_OPERATORS: WhereOperator[] = [
  "=",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "LIKE",
  "IN",
  "IS NULL",
  "IS NOT NULL",
];

export const AGGREGATE_FUNCTIONS: AggregateFunction[] = [
  "COUNT",
  "SUM",
  "AVG",
  "MAX",
  "MIN",
];

export interface CanvasTable {
  id: string;
  tableName: string;
  alias: string;
  columns: ColumnInfo[];
  selectedColumns: string[];
  aggregates: Record<string, AggregateFunction>;
  position: { x: number; y: number };
}

export interface JoinConfig {
  id: string;
  leftTableId: string;
  leftColumn: string;
  rightTableId: string;
  rightColumn: string;
  joinType: JoinType;
}

export interface WhereCondition {
  id: string;
  column: string;
  operator: WhereOperator;
  value: string;
  logic: LogicOperator;
}

export interface OrderByClause {
  id: string;
  column: string;
  direction: SortDirection;
}

export interface QueryBuilderState {
  tables: CanvasTable[];
  joins: JoinConfig[];
  where: WhereCondition[];
  orderBy: OrderByClause[];
  groupBy: string[];
  having: WhereCondition[];
  limit: number | null;
}

export const CARD_WIDTH = 220;
export const HEADER_HEIGHT = 36;
export const ROW_HEIGHT = 28;

function escapeIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function formatColumnRef(alias: string, column: string): string {
  return `${escapeIdentifier(alias)}.${escapeIdentifier(column)}`;
}

function formatSelectColumn(
  alias: string,
  column: string,
  aggregate?: AggregateFunction,
): string {
  const ref = formatColumnRef(alias, column);
  if (aggregate) {
    return `${aggregate}(${ref})`;
  }
  return ref;
}

function formatCondition(cond: WhereCondition): string {
  if (cond.operator === "IS NULL") {
    return `${cond.column} IS NULL`;
  }
  if (cond.operator === "IS NOT NULL") {
    return `${cond.column} IS NOT NULL`;
  }
  if (cond.operator === "IN") {
    return `${cond.column} IN (${cond.value})`;
  }
  if (cond.operator === "LIKE") {
    return `${cond.column} LIKE '${cond.value.replace(/'/g, "''")}'`;
  }
  const isNumeric = /^-?\d+(\.\d+)?$/.test(cond.value);
  const val = isNumeric ? cond.value : `'${cond.value.replace(/'/g, "''")}'`;
  return `${cond.column} ${cond.operator} ${val}`;
}

function formatConditions(conditions: WhereCondition[]): string {
  return conditions
    .map((cond, i) => {
      const condStr = formatCondition(cond);
      return i === 0 ? condStr : `${cond.logic} ${condStr}`;
    })
    .join("\n  ");
}

export function generateSQL(state: QueryBuilderState): string {
  if (state.tables.length === 0) return "";

  const lines: string[] = [];

  // SELECT
  const selectCols: string[] = [];
  for (const table of state.tables) {
    for (const col of table.selectedColumns) {
      const agg = table.aggregates[col];
      selectCols.push(formatSelectColumn(table.alias, col, agg));
    }
  }
  if (selectCols.length === 0) {
    lines.push("SELECT *");
  } else {
    lines.push("SELECT");
    lines.push("  " + selectCols.join(",\n  "));
  }

  // FROM
  const firstTable = state.tables[0];
  lines.push(
    `FROM ${escapeIdentifier(firstTable.tableName)} AS ${escapeIdentifier(firstTable.alias)}`,
  );

  // JOINs
  for (const join of state.joins) {
    const rightTable = state.tables.find((t) => t.id === join.rightTableId);
    const leftTable = state.tables.find((t) => t.id === join.leftTableId);
    if (!rightTable || !leftTable) continue;

    const onClause = `${formatColumnRef(leftTable.alias, join.leftColumn)} = ${formatColumnRef(rightTable.alias, join.rightColumn)}`;
    lines.push(
      `${join.joinType} JOIN ${escapeIdentifier(rightTable.tableName)} AS ${escapeIdentifier(rightTable.alias)} ON ${onClause}`,
    );
  }

  // WHERE
  if (state.where.length > 0) {
    lines.push("WHERE " + formatConditions(state.where));
  }

  // GROUP BY
  if (state.groupBy.length > 0) {
    lines.push("GROUP BY " + state.groupBy.join(", "));
  }

  // HAVING
  if (state.having.length > 0 && state.groupBy.length > 0) {
    lines.push("HAVING " + formatConditions(state.having));
  }

  // ORDER BY
  if (state.orderBy.length > 0) {
    const orderParts = state.orderBy.map((o) => `${o.column} ${o.direction}`);
    lines.push("ORDER BY " + orderParts.join(", "));
  }

  // LIMIT
  if (state.limit !== null && state.limit > 0) {
    lines.push(`LIMIT ${state.limit}`);
  }

  return lines.join("\n");
}

export function generateAlias(
  tableName: string,
  existingTables: CanvasTable[],
): string {
  const existing = existingTables.filter((t) => t.tableName === tableName);
  if (existing.length === 0) return tableName;
  return `${tableName}_${existing.length + 1}`;
}

export function getColumnRef(alias: string, column: string): string {
  return formatColumnRef(alias, column);
}

export function getAllColumnRefs(
  tables: CanvasTable[],
): { ref: string; label: string; alias: string; column: string }[] {
  const refs: { ref: string; label: string; alias: string; column: string }[] =
    [];
  for (const table of tables) {
    for (const col of table.columns) {
      const ref = formatColumnRef(table.alias, col.name);
      refs.push({
        ref,
        label: `${table.alias}.${col.name}`,
        alias: table.alias,
        column: col.name,
      });
    }
  }
  return refs;
}
