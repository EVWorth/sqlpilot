import type * as monacoNs from "monaco-editor";
import type { ColumnInfo } from "../types";

export interface SchemaData {
  connectionId: string | null;
  databases: string[];
  tables: Map<string, string[]>;
  views: Map<string, string[]>;
  columns: Map<string, ColumnInfo[]>;
  fetchTables: (connId: string, db: string) => Promise<string[]>;
  fetchViews: (connId: string, db: string) => Promise<string[]>;
  fetchColumns: (
    connId: string,
    db: string,
    table: string,
  ) => Promise<ColumnInfo[]>;
}

const MYSQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE",
  "ALTER",
  "DROP",
  "TABLE",
  "DATABASE",
  "INDEX",
  "VIEW",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "OUTER",
  "CROSS",
  "ON",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "IS",
  "NULL",
  "TRUE",
  "FALSE",
  "ORDER",
  "BY",
  "GROUP",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "ALL",
  "DISTINCT",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "IF",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "GRANT",
  "REVOKE",
  "PRIMARY",
  "KEY",
  "FOREIGN",
  "REFERENCES",
  "CONSTRAINT",
  "UNIQUE",
  "CHECK",
  "DEFAULT",
  "AUTO_INCREMENT",
  "UNSIGNED",
  "NOT NULL",
  "CASCADE",
  "TRUNCATE",
  "EXPLAIN",
  "DESCRIBE",
  "SHOW",
  "USE",
  "REPLACE",
  "IGNORE",
  "DUPLICATE",
  "TEMPORARY",
  "ENGINE",
  "CHARSET",
  "COLLATE",
  "COMMENT",
  "PARTITION",
  "PROCEDURE",
  "FUNCTION",
  "TRIGGER",
  "EVENT",
  "ASC",
  "DESC",
  "WITH",
  "RECURSIVE",
  "WINDOW",
  "OVER",
  "ROWS",
  "RANGE",
  "PRECEDING",
  "FOLLOWING",
  "CURRENT ROW",
  "UNBOUNDED",
];

const MYSQL_FUNCTIONS = [
  { name: "COUNT", detail: "COUNT(expr) — Aggregate count" },
  { name: "SUM", detail: "SUM(expr) — Aggregate sum" },
  { name: "AVG", detail: "AVG(expr) — Aggregate average" },
  { name: "MAX", detail: "MAX(expr) — Aggregate maximum" },
  { name: "MIN", detail: "MIN(expr) — Aggregate minimum" },
  { name: "NOW", detail: "NOW() — Current datetime" },
  { name: "CURDATE", detail: "CURDATE() — Current date" },
  { name: "CURTIME", detail: "CURTIME() — Current time" },
  { name: "DATE_FORMAT", detail: "DATE_FORMAT(date, format)" },
  { name: "DATEDIFF", detail: "DATEDIFF(date1, date2)" },
  { name: "DATE_ADD", detail: "DATE_ADD(date, INTERVAL expr unit)" },
  { name: "DATE_SUB", detail: "DATE_SUB(date, INTERVAL expr unit)" },
  { name: "CONCAT", detail: "CONCAT(str1, str2, ...) — String concatenation" },
  { name: "CONCAT_WS", detail: "CONCAT_WS(sep, str1, str2, ...)" },
  { name: "SUBSTRING", detail: "SUBSTRING(str, pos, len)" },
  { name: "LENGTH", detail: "LENGTH(str) — String length in bytes" },
  { name: "CHAR_LENGTH", detail: "CHAR_LENGTH(str) — Character count" },
  { name: "TRIM", detail: "TRIM(str) — Remove whitespace" },
  { name: "UPPER", detail: "UPPER(str) — Uppercase" },
  { name: "LOWER", detail: "LOWER(str) — Lowercase" },
  { name: "REPLACE", detail: "REPLACE(str, from, to)" },
  { name: "COALESCE", detail: "COALESCE(val1, val2, ...) — First non-NULL" },
  { name: "IFNULL", detail: "IFNULL(expr, alt) — NULL fallback" },
  { name: "NULLIF", detail: "NULLIF(expr1, expr2)" },
  { name: "CAST", detail: "CAST(expr AS type)" },
  { name: "CONVERT", detail: "CONVERT(expr, type)" },
  { name: "GROUP_CONCAT", detail: "GROUP_CONCAT(expr) — Aggregate concat" },
  { name: "JSON_EXTRACT", detail: "JSON_EXTRACT(doc, path)" },
  { name: "JSON_OBJECT", detail: "JSON_OBJECT(key, val, ...)" },
  { name: "JSON_ARRAY", detail: "JSON_ARRAY(val, ...)" },
  { name: "UUID", detail: "UUID() — Generate UUID" },
  { name: "ROUND", detail: "ROUND(num, decimals)" },
  { name: "FLOOR", detail: "FLOOR(num)" },
  { name: "CEIL", detail: "CEIL(num)" },
  { name: "ABS", detail: "ABS(num)" },
  { name: "MOD", detail: "MOD(n, m)" },
  { name: "RAND", detail: "RAND() — Random float 0..1" },
  { name: "MD5", detail: "MD5(str) — MD5 hash" },
  { name: "SHA2", detail: "SHA2(str, hash_length)" },
];

type Context = "table" | "column" | "database" | "general";

const TABLE_CONTEXTS =
  /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|INTO|UPDATE|TABLE|TRUNCATE|DESCRIBE|DESC|EXPLAIN)\s+$/i;
const COLUMN_CONTEXTS =
  /\b(?:SELECT|WHERE|ON|SET|ORDER\s+BY|GROUP\s+BY|HAVING|AND|OR)\s+$/i;
const DATABASE_CONTEXTS = /\b(?:USE|DATABASE)\s+$/i;

function detectContext(textBeforeCursor: string): Context {
  // Do NOT trim — the regexes rely on trailing whitespace to confirm the
  // keyword is complete and the user is starting a new token.
  if (DATABASE_CONTEXTS.test(textBeforeCursor)) return "database";
  if (TABLE_CONTEXTS.test(textBeforeCursor)) return "table";
  if (COLUMN_CONTEXTS.test(textBeforeCursor)) return "column";
  return "general";
}

/** Extract table names referenced after FROM / JOIN in a SQL snippet. */
function parseFromTables(sql: string): string[] {
  const found: string[] = [];
  // Match FROM/JOIN followed by an optional db. prefix then the table name.
  // Handles back-tick quoting and aliases.
  const re =
    /\b(?:FROM|JOIN)\s+(?:`?\w+`?\.)?`?(\w+)`?(?:\s+(?:AS\s+)?`?\w+`?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    if (!MYSQL_KEYWORDS.includes(name.toUpperCase())) {
      found.push(name);
    }
  }
  return [...new Set(found)];
}

function findDotPrefix(
  model: monacoNs.editor.ITextModel,
  position: monacoNs.Position,
): string | null {
  const lineContent = model.getLineContent(position.lineNumber);
  const textBefore = lineContent.substring(0, position.column - 1);
  // Match `identifier.` at end
  const match = textBefore.match(/(\w+)\.\s*$/);
  return match ? match[1] : null;
}

export function createCompletionProvider(
  monaco: typeof monacoNs,
  schemaData: SchemaData,
): monacoNs.languages.CompletionItemProvider {
  return {
    triggerCharacters: [".", " "],

    provideCompletionItems: async (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range: monacoNs.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: monacoNs.languages.CompletionItem[] = [];
      const { connectionId, databases, tables, columns } = schemaData;

      // Check for dot-qualified access (db.table or table.column)
      const dotPrefix = findDotPrefix(model, position);
      if (dotPrefix && connectionId) {
        // Check if dotPrefix is a known database → suggest tables
        if (databases.includes(dotPrefix)) {
          const dbTables = await schemaData.fetchTables(
            connectionId,
            dotPrefix,
          );
          for (const t of dbTables) {
            suggestions.push({
              label: t,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: t,
              range,
              sortText: "0" + t,
              detail: `Table in ${dotPrefix}`,
            });
          }
          return { suggestions };
        }

        // Otherwise, assume it's a table name → suggest columns
        // Search all known databases for this table
        for (const [db, dbTables] of tables.entries()) {
          if (
            dbTables
              .map((t) => t.toLowerCase())
              .includes(dotPrefix.toLowerCase())
          ) {
            const tableName =
              dbTables.find(
                (t) => t.toLowerCase() === dotPrefix.toLowerCase(),
              ) ?? dotPrefix;
            const cols = await schemaData.fetchColumns(
              connectionId,
              db,
              tableName,
            );
            for (const col of cols) {
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col.name,
                range,
                detail: col.column_type,
                documentation: buildColumnDoc(col),
                sortText: "0" + col.name,
              });
            }
            if (suggestions.length > 0) return { suggestions };
          }
        }

        return { suggestions };
      }

      // Context-based completions
      const textBeforeCursor = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: word.startColumn,
      });

      const context = detectContext(textBeforeCursor);
      let priority = 0;

      // Database suggestions
      if (context === "database" || context === "general") {
        const dbPriority = context === "database" ? "0" : "3";
        for (const db of databases) {
          suggestions.push({
            label: db,
            kind: monaco.languages.CompletionItemKind.Module,
            insertText: db,
            range,
            sortText: dbPriority + db,
            detail: "Database",
          });
        }
      }

      // Table/view suggestions — only for table context (after FROM/JOIN/etc.)
      if (connectionId && context === "table") {
        for (const [db, dbTables] of tables.entries()) {
          for (const t of dbTables) {
            suggestions.push({
              label: t,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: t,
              range,
              sortText: "0" + t,
              detail: `Table (${db})`,
            });
          }
        }
        for (const [db, dbViews] of schemaData.views.entries()) {
          for (const v of dbViews) {
            suggestions.push({
              label: v,
              kind: monaco.languages.CompletionItemKind.Interface,
              insertText: v,
              range,
              sortText: "0" + v,
              detail: `View (${db})`,
            });
          }
        }
        return { suggestions };
      }

      // Table suggestions for general/column contexts (lower priority)
      if (
        connectionId &&
        (context === "column" || context === "general")
      ) {
        const tablePriority = context === "general" ? "2" : "3";
        for (const [db, dbTables] of tables.entries()) {
          for (const t of dbTables) {
            suggestions.push({
              label: t,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: t,
              range,
              sortText: tablePriority + t,
              detail: `Table (${db})`,
            });
          }
        }
      }

      // Column suggestions — prefer columns from tables referenced in the FROM clause
      if (connectionId && (context === "column" || context === "general")) {
        const colPriority = context === "column" ? "0" : "4";
        const fullSql = model.getValue();
        const fromTables = parseFromTables(fullSql);

        if (fromTables.length > 0) {
          // Fetch and suggest only columns for tables present in the FROM clause
          for (const tableName of fromTables) {
            for (const [db, dbTables] of tables.entries()) {
              const match = dbTables.find(
                (t) => t.toLowerCase() === tableName.toLowerCase(),
              );
              if (match) {
                const key = `${db}.${match}`;
                const cachedCols = columns.get(key);
                const cols = cachedCols
                  ? cachedCols
                  : await schemaData.fetchColumns(connectionId, db, match);
                for (const col of cols) {
                  suggestions.push({
                    label: col.name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: col.name,
                    range,
                    detail: `${col.column_type} (${key})`,
                    documentation: buildColumnDoc(col),
                    sortText: colPriority + col.name,
                  });
                }
                break; // found db for this table
              }
            }
          }
        } else {
          // Fall back to all cached columns when no FROM tables are identifiable
          for (const [key, cols] of columns.entries()) {
            for (const col of cols) {
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col.name,
                range,
                detail: `${col.column_type} (${key})`,
                documentation: buildColumnDoc(col),
                sortText: colPriority + col.name,
              });
            }
          }
        }
      }

      // Keyword and function suggestions — only in general/column context
      if (context === "general" || context === "column") {
        priority = context === "general" ? 1 : 5;
        for (const kw of MYSQL_KEYWORDS) {
          suggestions.push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            range,
            sortText: String(priority) + kw,
          });
        }

        for (const fn of MYSQL_FUNCTIONS) {
          suggestions.push({
            label: fn.name,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: fn.name + "(${1})",
            insertTextRules:
              monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: fn.detail,
            sortText: String(priority) + fn.name,
          });
        }
      }

      return { suggestions };
    },
  };
}

function buildColumnDoc(col: ColumnInfo): string {
  const parts: string[] = [col.column_type];
  if (col.is_primary_key) parts.push("PRIMARY KEY");
  if (!col.nullable) parts.push("NOT NULL");
  if (col.default_value !== undefined) parts.push(`DEFAULT ${col.default_value}`);
  if (col.extra) parts.push(col.extra);
  if (col.comment) parts.push(`— ${col.comment}`);
  return parts.join(" | ");
}

export { MYSQL_KEYWORDS, MYSQL_FUNCTIONS, detectContext, findDotPrefix, parseFromTables };
export type { Context };
