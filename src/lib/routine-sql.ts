import { quoteIdentifier, quoteStringLiteral } from "./sql-quote";
import { isExactNumericType, isNumericSqlType } from "./sql-types";

/**
 * Building the SQL the routine viewer runs.
 *
 * All of it used to be assembled inline with template literals: identifiers
 * interpolated bare, and parameter values escaped by replacing `'` with `\'`.
 * That escape is not sufficient. MySQL treats a backslash as an escape
 * character inside a string literal unless NO_BACKSLASH_ESCAPES is set, and
 * it is off by default, so an input of
 *
 *     \' OR 1=1 --
 *
 * became `'\\' OR 1=1 -- '`, which MySQL reads as the one-character string
 * `\` followed by live SQL. Verified against MySQL 8: the injected predicate
 * runs (#397).
 */

/** A value ready to interpolate, or why it cannot be. */
export type ParamSql =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

/** Digits only, with an optional sign and decimal part. */
const EXACT_NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Render one routine argument as a SQL literal.
 *
 * A value that cannot be represented is refused rather than approximated.
 * Handing MySQL `'abc'` for an INT parameter is not an error there — it
 * coerces to 0 and runs the routine with a number the user never typed,
 * which is the same silent-wrong-value failure as the boolean cell in #421.
 */
export function formatParamValue(value: string, dataType: string): ParamSql {
  const trimmed = value.trim();

  if (isNumericSqlType(dataType)) {
    if (trimmed === "") {
      return { ok: false, reason: `${dataType} parameter needs a number` };
    }
    // BIGINT and DECIMAL keep their digits as text: Number() would drop the
    // last digit of a large id or the exactness of a decimal.
    if (isExactNumericType(dataType)) {
      return EXACT_NUMERIC.test(trimmed)
        ? { ok: true, sql: trimmed }
        : { ok: false, reason: `"${value}" is not a valid ${dataType}` };
    }
    const n = Number(trimmed);
    // Number("1e999") is Infinity, which stringifies to "Infinity" — not a
    // number MySQL will accept, and not one the user asked for.
    if (!Number.isFinite(n)) {
      return { ok: false, reason: `"${value}" is not a valid ${dataType}` };
    }
    return { ok: true, sql: String(n) };
  }

  return { ok: true, sql: quoteStringLiteral(value) };
}

/** `DROP PROCEDURE \`db\`.\`name\`` — the type is a closed set, not free text. */
export function buildDropRoutine(
  routineType: "PROCEDURE" | "FUNCTION",
  database: string,
  routineName: string,
): string {
  return `DROP ${routineType} ${quoteIdentifier(database)}.${quoteIdentifier(routineName)}`;
}

/** `SELECT \`db\`.\`fn\`(args) AS \`result\`` */
export function buildFunctionCall(
  database: string,
  routineName: string,
  args: string[],
): string {
  return `SELECT ${quoteIdentifier(database)}.${quoteIdentifier(routineName)}(${args.join(", ")}) AS ${
    quoteIdentifier("result")
  }`;
}

/**
 * Session-variable names for routine parameters.
 *
 * A parameter name comes from the routine's own declaration, so it is already
 * a valid identifier — but `SET @x` takes an unquoted name, and quoting it
 * with backticks would be wrong there. Refusing anything that is not a plain
 * identifier is cheaper than reasoning about what the server would accept.
 */
export function isPlainIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
