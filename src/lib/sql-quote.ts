/**
 * Quoting SQL fragments, in the two shapes MySQL actually distinguishes.
 *
 * These were previously two different functions both called
 * `escapeIdentifier` — one in `backup-generator.ts` returning backticks, one
 * in `admin/userPrivileges.ts` returning single quotes. Same name, different
 * output, different correct use. That is not a hypothetical hazard: it is easy
 * to read one and reason about the other.
 *
 * The distinction is not cosmetic. MySQL parses a backtick-quoted token as an
 * *identifier* (a name) and a single-quoted token as a *string literal* (a
 * value), and they escape by different rules.
 */

/**
 * Quote a name — database, table, column, index.
 *
 * Backticks, with any embedded backtick doubled. This is the only escape a
 * backtick-quoted identifier needs; a backslash is an ordinary character
 * inside one.
 */
export function quoteIdentifier(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

/**
 * Quote a value — a password, a user name, a host pattern.
 *
 * Doubling the quote is not sufficient. Unless `NO_BACKSLASH_ESCAPES` is set,
 * and it is off by default, MySQL treats a backslash as an escape character
 * inside a string literal. A password of `pa\ss` written as `'pa\ss'` is
 * stored as `pass`, because `\s` is not a recognised escape and collapses to
 * `s` — so the account is created with a password the user never typed and
 * cannot log in with.
 *
 * Backslashes are escaped first, so the backslashes this function introduces
 * are not themselves re-escaped by the later replacements.
 */
export function quoteStringLiteral(value: string): string {
  return (
    "'"
    + value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\0/g, "\\0")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1a/g, "\\Z")
    + "'"
  );
}
