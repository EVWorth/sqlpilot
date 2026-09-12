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

/**
 * The session variable a parameter is passed through.
 *
 * Prefixed rather than `@name`, because the connection is shared with the
 * editor: calling a procedure whose parameter is called `x` used to overwrite
 * whatever the user had put in `@x`, and there was no way to tell from the
 * editor that it had happened.
 */
export function paramVariable(name: string): string {
  return `@sqlpilot_param_${name}`;
}

/**
 * Which parameters cannot be sent as typed, and why.
 *
 * The same check the execute path makes, run as the user types, so the answer
 * arrives beside the input rather than as an error after clicking Execute
 * (#398). An OUT parameter takes no input, so it is never invalid.
 */
export function validateParams(
  params: { name: string; direction: string; dataType: string }[],
  values: Record<string, string>,
): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const p of params) {
    if (p.direction === "OUT") continue;
    const value = values[p.name];
    // Empty means NULL, which is a legitimate thing to pass.
    if (value === undefined || value === "") continue;
    const formatted = formatParamValue(value, p.dataType);
    if (!formatted.ok) problems[p.name] = formatted.reason;
  }
  return problems;
}

/**
 * The batch a procedure call runs: the parameters, the CALL, and reading the
 * OUT values back.
 *
 * One function rather than assembled in the component, so what is sent to the
 * server can be read and tested. The three statements go in one batch on
 * purpose: the executor runs a batch on a single pooled connection, and the
 * session variables holding the parameters only exist on that connection.
 * Sent separately they would not be guaranteed to reach the same session,
 * which is what the multi-statement shape is buying (#394).
 */
export function buildProcedureBatch(
  database: string,
  routineName: string,
  params: { name: string; direction: string; dataType: string }[],
  values: Record<string, string>,
): ParamSql {
  const oddName = params.find((p) => !isPlainIdentifier(p.name));
  if (oddName) {
    // `SET @name` takes the name unquoted, with no way to escape anything.
    return {
      ok: false,
      reason: `Cannot call this routine: the parameter name "${oddName.name}" is not a plain identifier`,
    };
  }

  const statements: string[] = [];
  for (const p of params) {
    const variable = paramVariable(p.name);
    if (p.direction === "OUT") {
      statements.push(`SET ${variable} = NULL`);
      continue;
    }
    const value = values[p.name];
    if (value === undefined || value === "") {
      statements.push(`SET ${variable} = NULL`);
      continue;
    }
    const formatted = formatParamValue(value, p.dataType);
    if (!formatted.ok) return { ok: false, reason: `${p.name}: ${formatted.reason}` };
    statements.push(`SET ${variable} = ${formatted.sql}`);
  }

  const args = params.map((p) => paramVariable(p.name)).join(", ");
  statements.push(
    `CALL ${quoteIdentifier(database)}.${quoteIdentifier(routineName)}(${args})`,
  );

  const outParams = params.filter((p) => p.direction === "OUT" || p.direction === "INOUT");
  if (outParams.length > 0) {
    const selected = outParams
      .map((p) => `${paramVariable(p.name)} AS ${quoteIdentifier(p.name)}`)
      .join(", ");
    statements.push(`SELECT ${selected}`);
  }

  return { ok: true, sql: statements.join(";\n") + ";" };
}
