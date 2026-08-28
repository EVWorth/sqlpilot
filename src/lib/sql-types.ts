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
 * Values carried as strings to survive JSON must still be emitted unquoted in
 * SQL. Verify the text really is a number first: trusting the column type alone
 * would splice arbitrary text into a statement unquoted if the two ever
 * disagreed.
 */
const NUMERIC_LITERAL_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function isNumericLiteral(text: string): boolean {
  return NUMERIC_LITERAL_RE.test(text.trim());
}
