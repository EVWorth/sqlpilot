import { quoteIdentifier, quoteStringLiteral } from "./sql-quote";

/**
 * Render one CSV cell as a SQL literal.
 *
 * The escaping is the shared one rather than a third copy of the rules. The
 * risk this closes is the one #364 names: the escape table is the security
 * boundary, and three implementations of it means three chances for a future
 * change to drop a transformation from one of them. There is now one, with
 * its own tests, used by the grid, the routine viewer, admin and here.
 *
 * The only rule dropped in the move is escaping a tab as \t. A literal tab
 * inside a quoted string is valid MySQL and round-trips unchanged, so the
 * value is the same; only the statement's appearance differs.
 */
function csvCellToSql(value: string, wasBareEmpty: boolean): string {
  // `,,` is an absent value and `,"",` is an empty string. The parser keeps
  // the difference now, so the file decides rather than this function: a bare
  // empty becomes NULL, a quoted one stays "" (#578).
  if (wasBareEmpty) {
    return "NULL";
  }
  return quoteStringLiteral(value);
}

/**
 * Generate batch INSERT statements from rows of data.
 * Returns an array of INSERT statements, each with up to `batchSize` rows.
 */
export function generateBatchInsert(
  tableName: string,
  columns: string[],
  rows: string[][],
  batchSize: number,
  /**
   * Which cells were written bare, from the parser. Absent means every empty
   * cell is treated as NULL, which is what callers without the information
   * used to get.
   */
  bareEmpty?: boolean[][],
): string[] {
  if (rows.length === 0 || columns.length === 0) return [];

  const escapedTable = quoteIdentifier(tableName);
  const escapedCols = columns.map(quoteIdentifier).join(", ");
  const statements: string[] = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const valueRows = batch.map((row, batchIdx) => {
      const rowBare = bareEmpty?.[i + batchIdx];
      const values = columns.map((_, colIdx) => {
        const cell = row[colIdx] ?? "";
        // A missing cell — the row is short — is absent, not empty.
        const bare = rowBare ? (rowBare[colIdx] ?? true) : cell === "";
        return csvCellToSql(cell, bare);
      });
      return `(${values.join(", ")})`;
    });
    statements.push(
      `INSERT INTO ${escapedTable} (${escapedCols}) VALUES\n${valueRows.join(",\n")};`,
    );
  }

  return statements;
}

/** One statement, and where it sits in the text it came from. */
export interface StatementRange {
  /** The statement, trimmed — what `splitSqlStatements` returns. */
  text: string;
  /** Offset of the first character of `text` in the original SQL. */
  start: number;
  /** Offset one past its last character. */
  end: number;
}

/**
 * Split a SQL file into individual statements.
 * Handles semicolons inside quoted strings and DELIMITER changes.
 */
export function splitSqlStatements(sql: string): string[] {
  return splitSqlStatementRanges(sql).map((s) => s.text);
}

/** What the editor wants that a file importer does not. */
export interface SplitOptions {
  /**
   * Treat a blank line as a statement boundary as well as the delimiter.
   *
   * For the editor, where a scratch buffer of unterminated SELECTs separated
   * by blank lines is the ordinary way people work. Never for a file: a
   * blank line inside a formatted statement is not a boundary there.
   */
  blankLineSeparates?: boolean;
  /**
   * Keep the delimiter on the end of each statement.
   *
   * The importer strips it — it is re-adding one per statement anyway. The
   * editor keeps it, so what it sends is what is on screen.
   */
  keepTerminator?: boolean;
}

/**
 * The same split, keeping each statement's position.
 *
 * The editor needs the positions to answer "which statement is the cursor
 * in?" — it used to scan backwards for a semicolon, which is wrong the moment
 * one appears inside a string or a comment (#298 F-backlog).
 */
export function splitSqlStatementRanges(
  sql: string,
  options: SplitOptions = {},
): StatementRange[] {
  const statements: StatementRange[] = [];
  let current = "";
  let delimiter = ";";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = i + 1 < sql.length ? sql[i + 1] : "";

    // Handle comments
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
      }
      current += ch;
      continue;
    }

    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += "/";
        i++;
        inBlockComment = false;
      }
      continue;
    }

    // Handle quoted strings
    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i++;
      } else if (ch === "\\") {
        if (next) {
          current += next;
          i++;
        }
      } else if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      if (ch === "\"") {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inBacktick) {
      current += ch;
      if (ch === "`") {
        inBacktick = false;
      }
      continue;
    }

    // Detect start of comments
    // Per MySQL spec, `--` is only a line comment when followed by whitespace or newline
    if (ch === "-" && next === "-") {
      const afterDash = sql[i + 2] ?? "\n";
      if (afterDash === " " || afterDash === "\t" || afterDash === "\n" || afterDash === "\r") {
        inLineComment = true;
        current += ch;
        continue;
      }
    }
    if (ch === "#") {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      current += ch;
      continue;
    }

    // Detect quotes
    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      continue;
    }
    if (ch === "\"") {
      inDoubleQuote = true;
      current += ch;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      current += ch;
      continue;
    }

    // Check for DELIMITER command
    const remaining = sql.slice(i).toUpperCase();
    if (remaining.startsWith("DELIMITER ") && current.trim() === "") {
      const restOfLine = sql.slice(i + 10);
      const eol = restOfLine.indexOf("\n");
      const newDelim = (eol === -1 ? restOfLine : restOfLine.slice(0, eol)).trim();
      if (newDelim) {
        delimiter = newDelim;
        i += 10 + (eol === -1 ? restOfLine.length : eol);
        current = "";
        continue;
      }
    }

    // A blank line ends a statement too, when the caller asked for it. Only
    // outside quotes and comments, which is why it is here rather than in a
    // pass of its own.
    if (options.blankLineSeparates && ch === "\n" && i > 0 && sql[i - 1] === "\n") {
      push(current, i);
      current = "";
      continue;
    }

    // Check for delimiter
    if (sql.slice(i, i + delimiter.length) === delimiter) {
      if (options.keepTerminator) {
        push(current + delimiter, i + delimiter.length);
      } else {
        push(current, i);
      }
      current = "";
      i += delimiter.length - 1;
      continue;
    }

    current += ch;
  }

  push(current, sql.length);

  return statements;

  /**
   * Record what has accumulated, if it is anything.
   *
   * `current` is always the contiguous run of characters ending just before
   * `endOffset`, so its position in the original text follows from its
   * length — no separate bookkeeping to fall out of step.
   */
  function push(raw: string, endOffset: number): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const rawStart = endOffset - raw.length;
    const lead = raw.length - raw.trimStart().length;
    statements.push({
      text: trimmed,
      start: rawStart + lead,
      end: rawStart + lead + trimmed.length,
    });
  }
}
