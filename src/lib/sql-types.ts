/**
 * Column-type helpers.
 *
 * Values that cannot survive a JSON number are carried as strings: BIGINT
 * exceeds 2^53, and DECIMAL is exact by definition and would be corrupted by
 * f64. That means the JavaScript type of a cell no longer tells you whether it
 * is a number — a BIGINT and a VARCHAR both arrive as strings.
 *
 * So anything that needs to know "is this numeric?" must ask the *column*, not
 * the value. This is the approach SQLyog takes (`IS_NUM(field->type)` drives
 * both right-alignment and whether a generated INSERT quotes the value) and
 * the reason mysql2-based clients can hand back big numbers as strings without
 * breaking their SQL generation.
 */

/** MySQL numeric column types, matched on the base name. */
const NUMERIC_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "INT",
  "INTEGER",
  "BIGINT",
  "DECIMAL",
  "NUMERIC",
  "FLOAT",
  "DOUBLE",
  "REAL",
  "BIT",
  "YEAR",
]);

/**
 * Strip any length/precision and the UNSIGNED / ZEROFILL suffixes, so
 * `DECIMAL(20,4)` and `BIGINT UNSIGNED` both reduce to their base name.
 */
export function baseSqlType(dataType: string): string {
  return dataType
    .toUpperCase()
    .replace(/\(.*$/, "")
    .replace(/\s+(UNSIGNED|ZEROFILL)\b/g, "")
    .trim();
}

/** True when the column holds a number, whatever JS type the value arrived as. */
export function isNumericSqlType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  return NUMERIC_TYPES.has(baseSqlType(dataType));
}

/**
 * Numeric types whose values cannot round-trip through a JavaScript number.
 *
 * BIGINT exceeds 2^53 and DECIMAL is exact by definition, so both are carried
 * as text from Rust. Anything that turns user input back into a value must
 * leave these as strings — `Number("9007199254740993")` loses the last digit,
 * which would corrupt the row on save. (#502)
 */
const EXACT_NUMERIC_TYPES = new Set(["BIGINT", "DECIMAL", "NUMERIC"]);

export function isExactNumericType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  return EXACT_NUMERIC_TYPES.has(baseSqlType(dataType));
}

/** Columns rendered as a checkbox rather than a text field. */
export function isBooleanSqlType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  const base = baseSqlType(dataType);
  return base === "BOOL" || base === "BOOLEAN" || /^tinyint\(1\)$/i.test(dataType.trim());
}

/** Columns wide enough to want the full-content viewer. */
const LONG_TEXT_TYPES = new Set([
  "TEXT",
  "TINYTEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "BLOB",
  "TINYBLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  "JSON",
]);

export function isLongTextSqlType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  return LONG_TEXT_TYPES.has(baseSqlType(dataType));
}

/**
 * Values carried as strings to survive JSON must still be emitted unquoted in
 * SQL. Verify the text really is a number first: trusting the column type alone
 * would splice arbitrary text into a statement unquoted if the two ever
 * disagreed.
 */
const NUMERIC_LITERAL_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function isNumericLiteral(text: string): boolean {
  return NUMERIC_LITERAL_RE.test(text.trim());
}

/**
 * Read a typed boolean value, or `undefined` when the text is not one.
 *
 * A boolean column is a `TINYINT(1)`, and MySQL will happily accept a string
 * for one: `SET is_active = 'true'` stores 0, because 'true' is not numeric.
 * The statement succeeds, so nothing reports a problem and the row is quietly
 * wrong — the opposite of what was typed (#421).
 *
 * The spellings people actually type are accepted; anything else is rejected
 * rather than guessed at, because guessing is how the value became 0.
 */
export function parseBooleanInput(raw: string): 0 | 1 | undefined {
  const v = raw.trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(v)) return 1;
  if (["0", "false", "f", "no", "n", "off"].includes(v)) return 0;
  return undefined;
}
