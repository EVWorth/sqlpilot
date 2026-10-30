/**
 * Whether a tab's session is inside a transaction after the statements it
 * just ran (#843) — the fallback.
 *
 * The backend reports the session's state on a run's last result (#916),
 * and the editor takes that when it is there. It is not always: MySQL has no
 * `@@in_transaction` to read, the server may not say, and a failed run
 * reports nothing. Then the state is read off the statements themselves. That
 * is a best guess, and errs towards "open": the indicator and the prompts it
 * drives cost a click when wrong, while missing a transaction rolls back the
 * user's work without a word.
 */

/** The statement with comments stripped and whitespace collapsed, upper-cased. */
function head(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(--|#)[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Statements that commit whatever is open before they run (MySQL's implicit commit). */
const IMPLICIT_COMMIT = /^(CREATE|ALTER|DROP|TRUNCATE|RENAME|LOCK TABLES|UNLOCK TABLES|GRANT|REVOKE)\b/;

/** What one statement does to the session's transaction, or null for nothing. */
export function transactionEffect(sql: string): boolean | null {
  const s = head(sql);
  if (/^(BEGIN|START TRANSACTION|XA START|XA BEGIN)\b/.test(s) && !/^BEGIN NOT ATOMIC\b/.test(s)) return true;
  if (/^COMMIT\b.*\bAND CHAIN\b/.test(s) && !/\bAND NO CHAIN\b/.test(s)) return true;
  if (/^ROLLBACK\b.*\bTO\b/.test(s)) return null;
  if (/^(COMMIT|ROLLBACK)\b/.test(s)) return false;
  // Autocommit off makes the next write open a transaction and leaves it
  // open; turning it back on commits.
  if (/^SET\b.*\bAUTOCOMMIT\s*=\s*(0|OFF|FALSE)\b/.test(s)) return true;
  if (/^SET\b.*\bAUTOCOMMIT\s*=\s*(1|ON|TRUE)\b/.test(s)) return false;
  if (IMPLICIT_COMMIT.test(s)) return false;
  return null;
}

/** Whether a transaction is open after `statements`, given whether one was before. */
export function transactionAfter(statements: readonly string[], before: boolean): boolean {
  let open = before;
  for (const sql of statements) {
    const effect = transactionEffect(sql);
    if (effect !== null) open = effect;
  }
  return open;
}
