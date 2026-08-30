/**
 * Reading SQL well enough to decide whether to ask the user first.
 *
 * This is a warning gate, not a security boundary — the backend enforces
 * read-only connections. Its job is to notice a statement that will be hard to
 * undo before it runs on production.
 */

/**
 * Remove the parts of a statement the server ignores, and only those.
 *
 * String literals become empty so their contents cannot be mistaken for
 * keywords, and ordinary comments go entirely.
 *
 * MySQL's conditional comments are deliberately *not* removed. `/*! DROP *\/`
 * is not a comment to MySQL — it executes the contents — so stripping it is
 * how `/*! DROP *\/ TABLE users` reads as harmless while dropping the table.
 * Their inner SQL is kept, minus the optional version number, so it is checked
 * like anything else.
 */
export function stripNonExecutable(sql: string): string {
  return sql
    // Conditional comments execute: unwrap rather than remove.
    .replace(/\/\*!(?:\d{5,6})?([\s\S]*?)\*\//g, " $1 ")
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, "\"\"")
    .replace(/--[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Statements worth confirming before they run against production.
 *
 * Not every write — an UPDATE or INSERT is the ordinary business of a database
 * client, and prompting for each would train the user to dismiss the dialog.
 * These are the ones that discard data, change who can reach it, or cannot be
 * undone by running the opposite statement.
 */
const DESTRUCTIVE_VERBS = [
  "DROP",
  "DELETE",
  "TRUNCATE",
  "ALTER",
  "RENAME",
  "GRANT",
  "REVOKE",
  "KILL",
  "FLUSH",
  "SHUTDOWN",
];

/** Multi-word forms that a single leading verb would miss. */
const DESTRUCTIVE_PHRASES = [
  /\bSET\s+PASSWORD\b/i,
  /\bLOCK\s+TABLES\b/i,
  /\bCREATE\s+USER\b/i,
  /\bDROP\s+USER\b/i,
];

const DESTRUCTIVE_RE = new RegExp(`\\b(${DESTRUCTIVE_VERBS.join("|")})\\b`, "i");

/**
 * Whether `sql` deserves a confirmation on a production connection.
 *
 * Checked anywhere in the statement rather than only at the front, because a
 * destructive statement can follow a harmless one in the same script.
 */
export function isDestructiveStatement(sql: string): boolean {
  const executable = stripNonExecutable(sql);
  if (DESTRUCTIVE_RE.test(executable)) return true;
  return DESTRUCTIVE_PHRASES.some((re) => re.test(executable));
}
