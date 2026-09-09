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

/**
 * Split a SQL file into individual statements.
 * Handles semicolons inside quoted strings and DELIMITER changes.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
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

    // Check for delimiter
    if (sql.slice(i, i + delimiter.length) === delimiter) {
      const trimmed = current.trim();
      if (trimmed) {
        statements.push(trimmed);
      }
      current = "";
      i += delimiter.length - 1;
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) {
    statements.push(trimmed);
  }

  return statements;
}
