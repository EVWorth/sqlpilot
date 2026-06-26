export function getStatementAtCursor(fullText: string, cursorLine: number, cursorColumn: number): string {
  const lines = fullText.split("\n");
  let charOffset = 0;
  for (let i = 0; i < cursorLine - 1; i++) {
    charOffset += lines[i].length + 1;
  }
  charOffset += cursorColumn - 1;

  let stmtStart = 0;
  let stmtEnd = fullText.length;

  for (let i = charOffset - 1; i >= 0; i--) {
    if (fullText[i] === ";") {
      stmtStart = i + 1;
      break;
    }
    if (i > 0 && fullText[i] === "\n" && fullText[i - 1] === "\n") {
      stmtStart = i + 1;
      break;
    }
  }

  for (let i = charOffset; i < fullText.length; i++) {
    if (fullText[i] === ";") {
      stmtEnd = i + 1;
      break;
    }
    if (i > 0 && fullText[i] === "\n" && fullText[i - 1] === "\n") {
      stmtEnd = i - 1;
      break;
    }
  }

  const result = fullText.slice(stmtStart, stmtEnd).trim();
  return result || fullText.trim();
}
