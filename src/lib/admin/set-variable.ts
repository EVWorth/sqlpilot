import type { ServerFlavour } from "../server-flavour";
import { quoteStringLiteral } from "../sql-quote";

/**
 * Building the SET for a server variable.
 *
 * FR-7.2.2 asks for inline editing of settable variables. The tab showed
 * values as read-only text, so changing one meant leaving the panel (#438).
 *
 * Verified against MySQL 8.0.46 and MariaDB 11:
 *
 *   SET GLOBAL max_connections = 151    both ok
 *   SET SESSION sql_mode = '...'        both ok
 *   SET GLOBAL version = '9'            both ERROR 1238, read only variable
 *   SET PERSIST max_connections = 151   MySQL ok, MariaDB ERROR 1064
 *
 * SET PERSIST is MySQL's alone. MariaDB has no equivalent, so persisting a
 * value there means editing the config file — which the panel cannot do and
 * should not pretend to.
 */

export type VariableScope = "global" | "session" | "persist";

/** The scopes this server actually supports. */
export function scopesFor(flavour: ServerFlavour): VariableScope[] {
  // Offering PERSIST on MariaDB would move the failure from "not offered" to
  // a syntax error after the user committed to it.
  return flavour === "mariadb"
    ? ["global", "session"]
    : ["global", "session", "persist"];
}

/**
 * Whether a change at this scope survives a restart.
 *
 * GLOBAL does not, which is the thing people are surprised by: the value
 * holds until the server stops and then quietly reverts to the config file.
 */
export function survivesRestart(scope: VariableScope): boolean {
  return scope === "persist";
}

const SCOPE_KEYWORD: Record<VariableScope, string> = {
  global: "GLOBAL",
  session: "SESSION",
  persist: "PERSIST",
};

/** True for a value that can go in unquoted. */
function isNumeric(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * The statement that sets `name` to `value`.
 *
 * The name is validated rather than quoted: a variable name is an identifier
 * in a position that takes no backticks, so the only safe handling is to
 * refuse anything that is not one.
 */
export function buildSetVariable(
  name: string,
  value: string,
  scope: VariableScope,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Not a variable name: ${name}`);
  }

  const trimmed = value.trim();
  // ON/OFF and DEFAULT are keywords here, not strings — quoting them sets the
  // variable to the literal text, which for a boolean is an error and for an
  // enum is a different value.
  const literal = isNumeric(trimmed) || /^(ON|OFF|DEFAULT|TRUE|FALSE)$/i.test(trimmed)
    ? trimmed.toUpperCase() === trimmed || isNumeric(trimmed) ? trimmed : trimmed.toUpperCase()
    : quoteStringLiteral(trimmed);

  return `SET ${SCOPE_KEYWORD[scope]} ${name} = ${literal}`;
}
