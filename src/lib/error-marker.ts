/**
 * Where a failed statement sits in the editor's text, for its error marker
 * (#845).
 *
 * The backend reports the failing statement by index into the SQL that ran,
 * which may be the selection or the statement at the cursor rather than the
 * whole buffer. Its text is looked up in the buffer instead: the first place
 * it appears is where the user will look for it.
 */

export interface MarkerRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** 1-based line and column of an offset, as Monaco counts them. */
function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return { line, column };
}

/** The range `statement` occupies in `text`, or null when it is not there. */
export function statementRange(text: string, statement: string): MarkerRange | null {
  const needle = statement.trim();
  if (!needle) return null;
  const start = text.indexOf(needle);
  if (start < 0) return null;
  const from = position(text, start);
  const to = position(text, start + needle.length);
  return {
    startLineNumber: from.line,
    startColumn: from.column,
    endLineNumber: to.line,
    endColumn: to.column,
  };
}
