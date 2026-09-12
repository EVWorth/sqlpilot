import { splitSqlStatementRanges } from "./sql-import";

/**
 * The statement the cursor is in, for "run the statement under the cursor".
 *
 * This used to scan backwards from the cursor for a semicolon or a blank
 * line. A semicolon inside a string literal, an identifier or a comment is
 * not a statement boundary, so
 *
 *     SELECT 'a;b' FROM orders;
 *
 * ran as `SELECT 'a` — a syntax error at best, and with the cursor in the
 * wrong place a *fragment* of a statement that still parses is worse than an
 * error, because it runs (#298 F-backlog).
 *
 * It now uses the same quote-, comment- and DELIMITER-aware splitter the SQL
 * importer and the restore dialog use, so a stored procedure body full of
 * semicolons is one statement here too.
 */
export function getStatementAtCursor(
  fullText: string,
  cursorLine: number,
  cursorColumn: number,
): string {
  const offset = offsetOf(fullText, cursorLine, cursorColumn);
  const statements = splitSqlStatementRanges(fullText, {
    // A scratch buffer of unterminated SELECTs separated by blank lines is
    // how people use the editor, and the terminator stays on so what runs is
    // what is on screen.
    blankLineSeparates: true,
    keepTerminator: true,
  });
  if (statements.length === 0) return fullText.trim();

  // Inside one, or on either edge of it: a cursor sitting just after the last
  // character of a statement is still in that statement, which is where it
  // ends up when you finish typing one.
  const containing = statements.find((s) => offset >= s.start && offset <= s.end);
  if (containing) return containing.text;

  // Between two — on the separator, or in the whitespace after it. The one
  // just before the cursor is the one that was being worked on.
  const before = [...statements].reverse().find((s) => s.end < offset);
  return (before ?? statements[0]).text;
}

/** Monaco's 1-based line and column as an offset into the text. */
function offsetOf(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return Math.min(offset + column - 1, text.length);
}
