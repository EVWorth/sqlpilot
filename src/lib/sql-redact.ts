/**
 * Strip credentials out of a statement before it is written down.
 *
 * The app is careful with passwords everywhere else: they live in the OS
 * keyring, and the profile fields carrying them are `#[serde(skip_serializing)]`
 * so they never cross the IPC boundary. A statement like
 * `CREATE USER 'x'@'%' IDENTIFIED BY 's3cret'` walks straight past all of that
 * — the password is part of the SQL text, and history stores SQL text (#587).
 *
 * Most competing clients record these verbatim. This is a place to be better
 * rather than to match, so redaction is not a preference: it happens on the way
 * into storage, and the plaintext is never written at all.
 *
 * The statement that actually runs is untouched. Only the recorded copy loses
 * its literals, and a redacted entry is marked as one so a user reading history
 * knows why it will not run as written.
 */

/** What replaces a credential literal, quotes and all. */
export const REDACTION = "<redacted>";

export interface RedactionResult {
  sql: string;
  /** True when at least one literal was replaced. */
  redacted: boolean;
}

/**
 * Keyword sequences that make the *next* string literal a credential.
 *
 * Anchored at the end, matched against the text preceding a literal. Working
 * from the keyword to the literal, rather than pattern-matching whole
 * statements, means an unfamiliar statement shape cannot smuggle a password
 * past by putting it somewhere a monolithic regex did not expect.
 */
const CREDENTIAL_PRECEDES = [
  // CREATE USER … IDENTIFIED BY 'pw' / IDENTIFIED BY PASSWORD '<hash>'
  /\bIDENTIFIED\s+BY\s+(?:PASSWORD\s+)?$/i,
  // MySQL's plugin form: IDENTIFIED WITH caching_sha2_password BY 'pw' | AS '<hash>'
  /\bIDENTIFIED\s+WITH\s+[`"'\w]+\s+(?:BY|AS)\s+$/i,
  // SET PASSWORD = 'pw', and the legacy PASSWORD('pw') wrapper
  /\bPASSWORD\s*(?:=|\()\s*$/i,
  // SET PASSWORD FOR 'u'@'h' = 'pw' — the target sits between the keyword and
  // the literal, so this reaches over it without crossing a statement break.
  /\bSET\s+PASSWORD\b[^;]*=\s*$/i,
  // Replication: CHANGE MASTER TO MASTER_PASSWORD = 'pw' and its 8.0 rename
  /\b(?:MASTER_PASSWORD|SOURCE_PASSWORD)\s*=\s*$/i,
  // CREATE SERVER … OPTIONS (USER 'u', PASSWORD 'pw')
  /\bPASSWORD\s+$/i,
];

/** The quote characters MySQL accepts around a string literal. */
const QUOTES = new Set(["'", "\""]);

interface Literal {
  start: number;
  end: number;
}

/**
 * Find every string literal in `sql`, skipping comments.
 *
 * Handles both escape conventions — a backslash and a doubled quote — because
 * a password containing a quote is exactly the case where a naive scan would
 * end the literal early and leave the rest of it in the recorded text.
 */
function findLiterals(sql: string): Literal[] {
  const found: Literal[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // Comments cannot contain a literal worth redacting, and their contents
    // would otherwise unbalance the quote scan.
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (ch === "#") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    // Backtick-quoted identifiers are not string literals, but they can hold
    // quote characters, so they have to be stepped over rather than scanned.
    if (ch === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "`" && sql[j + 1] === "`") j += 2;
        else if (sql[j] === "`") break;
        else j++;
      }
      i = j + 1;
      continue;
    }

    if (QUOTES.has(ch)) {
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\") j += 2;
        else if (sql[j] === quote && sql[j + 1] === quote) j += 2;
        else if (sql[j] === quote) break;
        else j++;
      }
      // An unterminated literal runs to the end of the text. Treating it as a
      // literal anyway is the safe reading: a truncated statement should not
      // become a way to keep a password.
      const end = Math.min(j + 1, sql.length);
      found.push({ start: i, end });
      i = end;
      continue;
    }

    i++;
  }

  return found;
}

/**
 * Replace credential literals in `sql` with {@link REDACTION}.
 *
 * The result is deliberately not runnable where a literal was removed. A
 * plausible-looking placeholder would be worse: re-running the entry would
 * quietly set the password to the placeholder.
 */
export function redactCredentials(sql: string): RedactionResult {
  const literals = findLiterals(sql);
  if (literals.length === 0) return { sql, redacted: false };

  let out = "";
  let cursor = 0;
  let redacted = false;

  for (const lit of literals) {
    const preceding = sql.slice(cursor, lit.start);
    out += preceding;
    cursor = lit.end;

    // Only the tail matters, and capping it keeps the scan linear on a long
    // statement rather than re-matching the whole prefix per literal.
    const context = out.length > 120 ? out.slice(-120) : out;
    if (CREDENTIAL_PRECEDES.some((p) => p.test(context))) {
      out += REDACTION;
      redacted = true;
    } else {
      out += sql.slice(lit.start, lit.end);
    }
  }

  out += sql.slice(cursor);
  return { sql: out, redacted };
}
