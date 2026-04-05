export interface CsvParseOptions {
  delimiter: string;
  hasHeader: boolean;
  quoteChar: string;
}

export interface CsvParseResult {
  headers: string[];
  rows: string[][];
}

export function parseCSV(content: string, options: CsvParseOptions): CsvParseResult {
  const { delimiter, hasHeader, quoteChar } = options;
  const lines = splitCSVLines(content, quoteChar);
  const rows: string[][] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    rows.push(parseCSVLine(line, delimiter, quoteChar));
  }

  if (rows.length === 0) {
    return { headers: [], rows: [] };
  }

  if (hasHeader) {
    const headers = rows.shift()!;
    return { headers, rows };
  }

  const headers = rows[0].map((_, i) => `column_${i + 1}`);
  return { headers, rows };
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

function parseCSVLine(line: string, delimiter: string, quoteChar: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === quoteChar) {
      if (inQuotes && i + 1 < line.length && line[i + 1] === quoteChar) {
        current += quoteChar;
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  fields.push(current);
  return fields;
}
