export interface CsvParseOptions {
  delimiter: string;
  hasHeader: boolean;
  quoteChar: string;
}

export interface CsvParseResult {
  headers: string[];
  rows: string[][];
  /**
   * Which cells were written bare, as `,,` rather than `,"",`.
   *
   * CSV distinguishes an absent value from an empty string, and the parser
   * used to discard that before anyone could act on it — so every empty cell
   * became SQL NULL, which fails on a NOT NULL column and silently replaces
   * "" on a nullable one (#578).
   *
   * Kept alongside `rows` rather than changing their type, so every existing
   * caller reads them unchanged and only the importer has to care.
   */
  bareEmpty: boolean[][];
}

export function parseCSV(content: string, options: CsvParseOptions): CsvParseResult {
  const { delimiter, hasHeader, quoteChar } = options;
  const lines = splitCSVLines(content, quoteChar);
  const rows: string[][] = [];
  const bare: boolean[][] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    const { fields, bareEmpty } = parseCSVLine(line, delimiter, quoteChar);
    rows.push(fields);
    bare.push(bareEmpty);
  }

  if (rows.length === 0) {
    return { headers: [], rows: [], bareEmpty: [] };
  }

  if (hasHeader) {
    const headers = rows.shift()!;
    bare.shift();
    return { headers, rows, bareEmpty: bare };
  }

  const headers = rows[0].map((_, i) => `column_${i + 1}`);
  return { headers, rows, bareEmpty: bare };
}

function splitCSVLines(content: string, quoteChar: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (ch === quoteChar) {
      if (inQuotes && i + 1 < content.length && content[i + 1] === quoteChar) {
        // Escaped quote
        current += quoteChar + quoteChar;
        i++;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && i + 1 < content.length && content[i + 1] === "\n") {
        i++;
      }
      lines.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

interface ParsedLine {
  fields: string[];
  /** True where the field carried no quotes at all and came out empty. */
  bareEmpty: boolean[];
}

function parseCSVLine(line: string, delimiter: string, quoteChar: string): ParsedLine {
  const fields: string[] = [];
  const bareEmpty: boolean[] = [];
  let current = "";
  let inQuotes = false;
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === quoteChar) {
      if (inQuotes && i + 1 < line.length && line[i + 1] === quoteChar) {
        current += quoteChar;
        i++;
      } else {
        inQuotes = !inQuotes;
        quoted = true;
      }
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current);
      bareEmpty.push(current === "" && !quoted);
      current = "";
      quoted = false;
    } else {
      current += ch;
    }
  }

  fields.push(current);
  bareEmpty.push(current === "" && !quoted);
  return { fields, bareEmpty };
}
