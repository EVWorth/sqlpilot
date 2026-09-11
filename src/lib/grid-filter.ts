import { isNumericSqlType } from "./sql-types";

/**
 * Per-column filters over the rows already fetched.
 *
 * FR-3.1.3. There was no filtering at all: narrowing a result meant editing
 * the query and running it again, which is a round trip to the server to
 * answer a question about data already on screen (#391).
 *
 * Deliberately client-side. A filter that re-ran the query would change what
 * the grid is showing underneath any pending edits, and would disagree with
 * the server about collation and NULL ordering in ways the user cannot see.
 * These filter the rows you have; the query is still how you choose which
 * rows to fetch.
 */

export type FilterOperator =
  | "contains"
  | "notContains"
  | "equals"
  | "notEquals"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "isNull"
  | "isNotNull"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between";

export interface ColumnFilter {
  operator: FilterOperator;
  /** Empty for the operators that take no operand. */
  value: string;
  /** The upper bound, for `between`. */
  value2?: string;
}

export const OPERATOR_LABEL: Record<FilterOperator, string> = {
  contains: "contains",
  notContains: "does not contain",
  equals: "equals",
  notEquals: "does not equal",
  startsWith: "starts with",
  endsWith: "ends with",
  regex: "matches regex",
  isNull: "is NULL",
  isNotNull: "is not NULL",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  between: "between",
};

/** Operators that ignore `value`, so the input is hidden rather than ignored. */
export const NULLARY_OPERATORS: ReadonlySet<FilterOperator> = new Set(["isNull", "isNotNull"]);

const TEXT_OPERATORS: FilterOperator[] = [
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
  "regex",
];

const ORDERED_OPERATORS: FilterOperator[] = ["gt", "gte", "lt", "lte", "between"];

const NULL_OPERATORS: FilterOperator[] = ["isNull", "isNotNull"];

/** Column types that compare as ordered values rather than as text. */
function isDateLike(dataType: string | undefined): boolean {
  const t = (dataType ?? "").toLowerCase();
  return t.startsWith("date") || t.startsWith("time") || t.startsWith("year");
}

/**
 * The operators worth offering for a column.
 *
 * FR-3.1.3 calls for a numeric range and a date range; both are the ordered
 * comparisons, differing only in how the operand is typed. Text columns keep
 * them too — `> 'm'` is a real question to ask of a surname — but they come
 * second, because contains is what you reach for.
 */
export function operatorsFor(dataType: string | undefined): FilterOperator[] {
  const ordered = isNumericSqlType(dataType) || isDateLike(dataType);
  return ordered
    ? [...ORDERED_OPERATORS, ...TEXT_OPERATORS, ...NULL_OPERATORS]
    : [...TEXT_OPERATORS, ...ORDERED_OPERATORS, ...NULL_OPERATORS];
}

/** The default operator for a column, used when a filter is first opened. */
export function defaultOperator(dataType: string | undefined): FilterOperator {
  return operatorsFor(dataType)[0] ?? "contains";
}

/** True when a filter would actually narrow anything. */
export function isActiveFilter(filter: ColumnFilter | undefined): filter is ColumnFilter {
  if (!filter) return false;
  if (NULLARY_OPERATORS.has(filter.operator)) return true;
  if (filter.operator === "between") {
    return filter.value.trim() !== "" && (filter.value2 ?? "").trim() !== "";
  }
  return filter.value.trim() !== "";
}

/**
 * Compare as numbers when both sides really are numbers, as text otherwise.
 *
 * A column's declared type is not enough on its own: BIGINT and DECIMAL travel
 * as strings so JSON cannot truncate them, and a text column can still hold
 * "10". Falling back to text keeps `between` usable on a VARCHAR without
 * making `'10' < '9'` a surprise on an INT.
 */
function compare(cell: unknown, operand: string): number {
  const cellNum = typeof cell === "number" ? cell : Number(String(cell));
  const operandNum = Number(operand);
  if (
    operand.trim() !== "" && Number.isFinite(cellNum) && Number.isFinite(operandNum)
    && String(cell).trim() !== ""
  ) {
    return cellNum - operandNum;
  }
  return String(cell).localeCompare(operand);
}

/**
 * Does one cell pass one filter?
 *
 * NULL passes only `isNull`. Every other operator on a NULL cell is false,
 * matching SQL: a filter for "does not equal x" should not start reporting
 * rows whose value is unknown.
 */
export function matchesFilter(cell: unknown, filter: ColumnFilter): boolean {
  const isNull = cell === null || cell === undefined;
  if (filter.operator === "isNull") return isNull;
  if (filter.operator === "isNotNull") return !isNull;
  if (isNull) return false;

  const text = String(cell);
  const needle = filter.value;

  switch (filter.operator) {
    case "contains":
      return text.toLowerCase().includes(needle.toLowerCase());
    case "notContains":
      return !text.toLowerCase().includes(needle.toLowerCase());
    case "equals":
      return text.toLowerCase() === needle.toLowerCase();
    case "notEquals":
      return text.toLowerCase() !== needle.toLowerCase();
    case "startsWith":
      return text.toLowerCase().startsWith(needle.toLowerCase());
    case "endsWith":
      return text.toLowerCase().endsWith(needle.toLowerCase());
    case "regex":
      try {
        return new RegExp(needle, "i").test(text);
      } catch {
        // A half-typed pattern is not a reason to empty the grid; it shows
        // everything until the pattern is valid.
        return true;
      }
    case "gt":
      return compare(cell, needle) > 0;
    case "gte":
      return compare(cell, needle) >= 0;
    case "lt":
      return compare(cell, needle) < 0;
    case "lte":
      return compare(cell, needle) <= 0;
    case "between":
      return compare(cell, needle) >= 0 && compare(cell, filter.value2 ?? "") <= 0;
  }
}

/** A one-line description of a filter, for the header tooltip. */
export function describeFilter(column: string, filter: ColumnFilter): string {
  const op = OPERATOR_LABEL[filter.operator];
  if (NULLARY_OPERATORS.has(filter.operator)) return `${column} ${op}`;
  if (filter.operator === "between") {
    return `${column} ${op} ${filter.value} and ${filter.value2 ?? ""}`;
  }
  return `${column} ${op} ${filter.value}`;
}
