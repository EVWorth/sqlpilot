/**
 * Escape a value for use in a MySQL INSERT statement.
 */
function escapeValue(value: string): string {
  if (value === "") {
    return "NULL";
  }
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\0/g, "\\0");
  return `'${escaped}'`;
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
): string[] {
  if (rows.length === 0 || columns.length === 0) return [];

  const escapedTable = `\`${tableName.replace(/`/g, "``")}\``;
  const escapedCols = columns.map((c) => `\`${c.replace(/`/g, "``")}\``).join(", ");
  const statements: string[] = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const valueRows = batch.map((row) => {
      const values = columns.map((_, colIdx) => escapeValue(row[colIdx] ?? ""));
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
      if (ch === '"') {
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
    if (ch === '"') {
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
