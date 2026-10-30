// The SQLite statement splitter, shared by the mock backend and the result
// store, which must find the failing statement of a script the way
// `mas-sqlite` split it (#932).

/**
 * Split a script as `mas-sqlite` does (#928): its splitter is a port of
 * `sqlite3_complete`, and this is the same state machine. Semicolons inside
 * strings, quoted names and comments do not split, a trigger body runs to its
 * `END;`, and a piece with nothing but comments in it is not a statement.
 * Each statement comes back trimmed and without its `;`, as the backend's
 * `sql` field has it.
 */
export function splitSqliteStatements(sql: string): string[] {
  // Rows are states, columns tokens: SEMI WS OTHER EXPLAIN CREATE TEMP TRIGGER END.
  const TRANSITIONS = [
    [1, 0, 2, 3, 4, 2, 2, 2],
    [1, 1, 2, 3, 4, 2, 2, 2],
    [1, 2, 2, 2, 2, 2, 2, 2],
    [1, 3, 3, 2, 4, 2, 2, 2],
    [1, 4, 2, 2, 2, 4, 5, 2],
    [6, 5, 5, 5, 5, 5, 5, 5],
    [6, 6, 5, 5, 5, 5, 5, 7],
    [1, 7, 5, 5, 5, 5, 5, 5],
  ];
  const [SEMI, WS, OTHER] = [0, 1, 2];
  const KEYWORDS: Record<string, number> = { explain: 3, create: 4, temp: 5, temporary: 5, trigger: 6, end: 7 };
  const idChar = /[A-Za-z0-9_$\u0080-\uffff]/;
  const upTo = (from: number, needle: string, extra: number) => {
    const at = sql.indexOf(needle, from);
    return at === -1 ? sql.length : at + extra;
  };

  const out: string[] = [];
  let state = 0;
  let start = 0;
  let hasContent = false;
  const push = (end: number) => {
    const text = sql.slice(start, end).trim().replace(/;$/, "").trimEnd();
    if (hasContent) out.push(text);
  };
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    let token = OTHER;
    let end = i + 1;
    if (ch === ";") token = SEMI;
    else if (/\s/.test(ch)) token = WS;
    else if (ch === "/" && sql[i + 1] === "*") [token, end] = [WS, upTo(i + 2, "*/", 2)];
    else if (ch === "-" && sql[i + 1] === "-") [token, end] = [WS, upTo(i, "\n", 1)];
    else if (ch === "[") end = upTo(i, "]", 1);
    else if (ch === "'" || ch === "\"" || ch === "`") end = upTo(i + 1, ch, 1);
    else if (idChar.test(ch)) {
      while (end < sql.length && idChar.test(sql[end])) end++;
      token = KEYWORDS[sql.slice(i, end).toLowerCase()] ?? OTHER;
    }
    state = TRANSITIONS[state][token];
    if (token === SEMI && state === 1) {
      push(end);
      start = end;
      hasContent = false;
    } else if (token !== SEMI && token !== WS) {
      hasContent = true;
    }
    i = end;
  }
  push(sql.length);
  return out;
}
