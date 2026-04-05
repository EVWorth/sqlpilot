export interface RoutineParameter {
  direction: "IN" | "OUT" | "INOUT";
  name: string;
  dataType: string;
}

export interface RoutineMetadata {
  parameters: RoutineParameter[];
  returnsType?: string;
  isDeterministic?: boolean;
  sqlSecurity?: string;
  comment?: string;
}

/**
 * Parse parameters from a CREATE PROCEDURE or CREATE FUNCTION DDL statement.
 */
export function parseRoutineParameters(ddl: string): RoutineParameter[] {
  return parseRoutineMetadata(ddl).parameters;
}

/**
 * Parse full metadata from a CREATE PROCEDURE or CREATE FUNCTION DDL statement.
 */
export function parseRoutineMetadata(ddl: string): RoutineMetadata {
  const meta: RoutineMetadata = { parameters: [] };

  const isFunction = /CREATE\s+(DEFINER\s*=\s*\S+\s+)?FUNCTION\s/i.test(ddl);

  // Extract the parenthesized parameter list.
  // Match the first balanced parentheses after the routine name.
  const paramStr = extractParamString(ddl);
  if (paramStr !== null && paramStr.trim().length > 0) {
    meta.parameters = splitParams(paramStr).map((p) =>
      parseSingleParam(p.trim(), isFunction),
    );
  }

  // RETURNS clause (functions only)
  const returnsMatch = ddl.match(/\)\s+RETURNS\s+(\S+(?:\([^)]*\))?)/i);
  if (returnsMatch) {
    meta.returnsType = returnsMatch[1];
  }

  // DETERMINISTIC (check NOT DETERMINISTIC first to avoid false positive)
  if (/\bNOT\s+DETERMINISTIC\b/i.test(ddl)) {
    meta.isDeterministic = false;
  } else if (/\bDETERMINISTIC\b/i.test(ddl)) {
    meta.isDeterministic = true;
  }

  // SQL SECURITY
  const secMatch = ddl.match(/SQL\s+SECURITY\s+(DEFINER|INVOKER)/i);
  if (secMatch) {
    meta.sqlSecurity = secMatch[1].toUpperCase();
  }

  // COMMENT
  const commentMatch = ddl.match(/COMMENT\s+'((?:[^'\\]|\\.|'')*)'/i);
  if (commentMatch) {
    meta.comment = commentMatch[1].replace(/''/g, "'").replace(/\\'/g, "'");
  }

  return meta;
}

/**
 * Extract the parameter string from inside the first balanced parentheses
 * after the routine name identifier.
 */
function extractParamString(ddl: string): string | null {
  // Find the opening paren after CREATE [DEFINER=...] PROCEDURE|FUNCTION `name`
  const headerMatch = ddl.match(
    /CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION)\s+(?:`[^`]+`\.)?`?[^`(\s]+`?\s*\(/i,
  );
  if (!headerMatch) return null;

  const startIdx = headerMatch.index! + headerMatch[0].length - 1; // position of '('
  let depth = 0;
  let i = startIdx;
  for (; i < ddl.length; i++) {
    if (ddl[i] === "(") depth++;
    else if (ddl[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  return ddl.substring(startIdx + 1, i);
}

/**
 * Split a parameter string on commas, respecting parentheses and quotes.
 */
function splitParams(paramStr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inSingleQuote = false;

  for (let i = 0; i < paramStr.length; i++) {
    const ch = paramStr[i];
    if (ch === "'" && !inSingleQuote) {
      inSingleQuote = true;
      current += ch;
    } else if (ch === "'" && inSingleQuote) {
      // Check for escaped quote ('')
      if (i + 1 < paramStr.length && paramStr[i + 1] === "'") {
        current += "''";
        i++;
      } else {
        inSingleQuote = false;
        current += ch;
      }
    } else if (inSingleQuote) {
      current += ch;
    } else if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts;
}

/**
 * Parse a single parameter token like "IN param1 INT" or "name VARCHAR(100)".
 */
function parseSingleParam(
  param: string,
  isFunction: boolean,
): RoutineParameter {
  const tokens = param.trim().split(/\s+/);
  if (tokens.length === 0) {
    return { direction: "IN", name: "", dataType: "" };
  }

  const firstUpper = tokens[0].toUpperCase();
  let direction: RoutineParameter["direction"] = "IN";
  let nameIdx = 0;

  if (firstUpper === "IN" || firstUpper === "OUT" || firstUpper === "INOUT") {
    direction = firstUpper as RoutineParameter["direction"];
    nameIdx = 1;
  } else if (isFunction) {
    // Function params have no direction keyword; default to IN
    direction = "IN";
    nameIdx = 0;
  }

  const name = (tokens[nameIdx] || "").replace(/`/g, "");
  const dataType = tokens
    .slice(nameIdx + 1)
    .join(" ")
    .trim();

  return { direction, name, dataType };
}
