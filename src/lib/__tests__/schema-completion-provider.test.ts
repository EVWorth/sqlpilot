import { describe, it, expect, vi } from "vitest";
import {
  detectContext,
  parseFromTables,
  findDotPrefix,
  MYSQL_KEYWORDS,
  MYSQL_FUNCTIONS,
  createCompletionProvider,
} from "../schema-completion-provider";
import type { SchemaData } from "../schema-completion-provider";
import type * as monacoNs from "monaco-editor";

function makeMockModel(lineContent: string, fullContent?: string, lineNumber = 1, column = lineContent.length + 1) {
  return {
    getLineContent: () => lineContent,
    getValue: () => fullContent ?? lineContent,
    getWordUntilPosition: () => ({ startColumn: column, endColumn: column }),
    getValueInRange: () => lineContent.substring(0, column - 1),
    getLineCount: () => 1,
  } as unknown as monacoNs.editor.ITextModel;
}

function makeMockPosition(lineNumber = 1, column = 1): monacoNs.Position {
  return { lineNumber, column } as monacoNs.Position;
}

const mockMonaco = {
  languages: {
    CompletionItemKind: {
      Keyword: 1,
      Function: 2,
      Field: 3,
      Enum: 4,
      Folder: 5,
      Interface: 6,
    },
    CompletionItemInsertTextRule: {
      InsertAsSnippet: 4,
    },
  },
  Position: class {
    constructor(public lineNumber: number, public column: number) {}
  },
  Range: class {},
} as unknown as typeof monacoNs;

describe("detectContext", () => {
  it("detects table context after FROM", () => {
    expect(detectContext("SELECT * FROM ")).toBe("table");
  });

  it("detects table context after JOIN", () => {
    expect(detectContext("SELECT * FROM users JOIN ")).toBe("table");
    expect(detectContext("SELECT * FROM users LEFT JOIN ")).toBe("table");
    expect(detectContext("SELECT * FROM users RIGHT OUTER JOIN ")).toBe("table");
    expect(detectContext("SELECT * FROM users CROSS JOIN ")).toBe("table");
    expect(detectContext("INNER JOIN ")).toBe("table");
    expect(detectContext("LEFT OUTER JOIN ")).toBe("table");
  });

  it("detects table context after INTO", () => {
    expect(detectContext("INSERT INTO ")).toBe("table");
  });

  it("detects table context after UPDATE", () => {
    expect(detectContext("UPDATE ")).toBe("table");
  });

  it("detects table context after TRUNCATE", () => {
    expect(detectContext("TRUNCATE ")).toBe("table");
  });

  it("detects table context after DESCRIBE/DESC/EXPLAIN", () => {
    expect(detectContext("DESCRIBE ")).toBe("table");
    expect(detectContext("DESC ")).toBe("table");
    expect(detectContext("EXPLAIN ")).toBe("table");
  });

  it("detects table context after TABLE (e.g. ALTER TABLE)", () => {
    expect(detectContext("ALTER TABLE ")).toBe("table");
  });

  it("detects column context after SELECT", () => {
    expect(detectContext("SELECT ")).toBe("column");
  });

  it("detects column context after WHERE", () => {
    expect(detectContext("SELECT * FROM users WHERE ")).toBe("column");
  });

  it("detects column context after ON", () => {
    expect(detectContext("SELECT * FROM users JOIN orders ON ")).toBe("column");
  });

  it("detects column context after SET", () => {
    expect(detectContext("UPDATE users SET ")).toBe("column");
  });

  it("detects column context after ORDER BY", () => {
    expect(detectContext("SELECT * FROM users ORDER BY ")).toBe("column");
  });

  it("detects column context after GROUP BY", () => {
    expect(detectContext("SELECT * FROM users GROUP BY ")).toBe("column");
  });

  it("detects column context after HAVING", () => {
    expect(detectContext("SELECT * FROM users HAVING ")).toBe("column");
  });

  it("detects column context after AND/OR", () => {
    expect(detectContext("SELECT * FROM users WHERE id=1 AND ")).toBe("column");
    expect(detectContext("SELECT * FROM users WHERE id=1 OR ")).toBe("column");
  });

  it("does NOT detect column context when AND/OR has no trailing space (mid-value)", () => {
    expect(detectContext("SELECT * FROM users WHERE id=1 AND")).toBe("general");
    expect(detectContext("SELECT * FROM users WHERE id=1 OR")).toBe("general");
  });

  it("detects database context after USE", () => {
    expect(detectContext("USE ")).toBe("database");
  });

  it("detects database context after DATABASE", () => {
    expect(detectContext("CREATE DATABASE ")).toBe("database");
    expect(detectContext("DROP DATABASE ")).toBe("database");
  });

  it("detects general context for unknown patterns", () => {
    expect(detectContext("")).toBe("general");
    expect(detectContext("hello world")).toBe("general");
    expect(detectContext("-- comment")).toBe("general");
  });

  it("is case insensitive", () => {
    expect(detectContext("select * from ")).toBe("table");
    expect(detectContext("where ")).toBe("column");
    expect(detectContext("use ")).toBe("database");
  });

  it("does NOT match keywords without trailing space (word is still being typed)", () => {
    expect(detectContext("FROM")).toBe("general");
    expect(detectContext("SELECT")).toBe("general");
    expect(detectContext("WHERE")).toBe("general");
  });
});

describe("parseFromTables", () => {
  it("extracts table from simple SELECT", () => {
    expect(parseFromTables("SELECT * FROM users")).toEqual(["users"]);
  });

  it("extracts multiple tables when JOIN has alias", () => {
    expect(
      parseFromTables("SELECT * FROM users u JOIN orders o"),
    ).toEqual(["users", "orders"]);
  });

  it("extracts table with alias", () => {
    expect(parseFromTables("SELECT * FROM users u")).toEqual(["users"]);
    expect(parseFromTables("SELECT * FROM users AS u")).toEqual(["users"]);
  });

  it("extracts table with database prefix", () => {
    expect(parseFromTables("SELECT * FROM mydb.users")).toEqual(["users"]);
    expect(parseFromTables("SELECT * FROM `mydb`.`users`")).toEqual(["users"]);
  });

  it("extracts backtick-quoted table names", () => {
    expect(parseFromTables("SELECT * FROM `users`")).toEqual(["users"]);
  });

  it("ignores SQL keywords as table names", () => {
    expect(parseFromTables("SELECT * FROM WHERE")).toEqual([]);
    expect(parseFromTables("SELECT * FROM SELECT")).toEqual([]);
    expect(parseFromTables("SELECT * FROM FROM")).toEqual([]);
  });

  it("deduplicates table names", () => {
    expect(
      parseFromTables("SELECT * FROM users JOIN users AS u2"),
    ).toEqual(["users"]);
  });

  it("handles empty input", () => {
    expect(parseFromTables("")).toEqual([]);
    expect(parseFromTables("SELECT 1")).toEqual([]);
  });

  it("handles complex queries", () => {
    const sql = `
      SELECT u.name, o.total
      FROM users u
      INNER JOIN orders o ON u.id = o.user_id
      LEFT JOIN products p ON o.product_id = p.id
    `;
    expect(parseFromTables(sql)).toEqual(["users", "orders", "products"]);
  });

  it("extracts table after LEFT JOIN with alias", () => {
    const sql = "SELECT * FROM users LEFT JOIN orders o ON users.id = o.user_id";
    expect(parseFromTables(sql)).toEqual(["users", "orders"]);
  });

  it("extracts table after RIGHT JOIN", () => {
    const sql = "SELECT * FROM users RIGHT JOIN orders ON users.id = orders.user_id";
    expect(parseFromTables(sql)).toEqual(["users", "orders"]);
  });
});

describe("findDotPrefix", () => {
  it("detects table. prefix", () => {
    const model = makeMockModel("users.", "SELECT * FROM users.", 1, 7);
    expect(findDotPrefix(model, makeMockPosition(1, 7))).toBe("users");
  });

  it("detects db.table. prefix", () => {
    const model = makeMockModel("mydb.users.", "SELECT * FROM mydb.users.", 1, 13);
    expect(findDotPrefix(model, makeMockPosition(1, 13))).toBe("users");
  });

  it("returns null when no dot prefix", () => {
    const model = makeMockModel("users", "SELECT * FROM users", 1, 6);
    expect(findDotPrefix(model, makeMockPosition(1, 6))).toBeNull();
  });

  it("returns null for empty line", () => {
    const model = makeMockModel("", "", 1, 1);
    expect(findDotPrefix(model, makeMockPosition(1, 1))).toBeNull();
  });

  it("handles identifier with underscores", () => {
    const model = makeMockModel("user_orders.", "SELECT * FROM user_orders.", 1, 14);
    expect(findDotPrefix(model, makeMockPosition(1, 14))).toBe("user_orders");
  });
});

describe("MYSQL_KEYWORDS", () => {
  it("contains common SQL keywords", () => {
    expect(MYSQL_KEYWORDS).toContain("SELECT");
    expect(MYSQL_KEYWORDS).toContain("FROM");
    expect(MYSQL_KEYWORDS).toContain("WHERE");
    expect(MYSQL_KEYWORDS).toContain("INSERT");
    expect(MYSQL_KEYWORDS).toContain("UPDATE");
    expect(MYSQL_KEYWORDS).toContain("DELETE");
  });

  it("contains DDL keywords", () => {
    expect(MYSQL_KEYWORDS).toContain("CREATE");
    expect(MYSQL_KEYWORDS).toContain("ALTER");
    expect(MYSQL_KEYWORDS).toContain("DROP");
  });

  it("contains clauses", () => {
    expect(MYSQL_KEYWORDS).toContain("ORDER");
    expect(MYSQL_KEYWORDS).toContain("GROUP");
    expect(MYSQL_KEYWORDS).toContain("HAVING");
    expect(MYSQL_KEYWORDS).toContain("LIMIT");
    expect(MYSQL_KEYWORDS).toContain("OFFSET");
  });

  it("contains join types", () => {
    expect(MYSQL_KEYWORDS).toContain("JOIN");
    expect(MYSQL_KEYWORDS).toContain("INNER");
    expect(MYSQL_KEYWORDS).toContain("LEFT");
    expect(MYSQL_KEYWORDS).toContain("RIGHT");
    expect(MYSQL_KEYWORDS).toContain("CROSS");
  });

  it("contains data types and modifiers", () => {
    expect(MYSQL_KEYWORDS).toContain("UNSIGNED");
    expect(MYSQL_KEYWORDS).toContain("AUTO_INCREMENT");
    expect(MYSQL_KEYWORDS).toContain("NOT NULL");
  });

  it("contains view/routine keywords", () => {
    expect(MYSQL_KEYWORDS).toContain("PROCEDURE");
    expect(MYSQL_KEYWORDS).toContain("FUNCTION");
    expect(MYSQL_KEYWORDS).toContain("TRIGGER");
    expect(MYSQL_KEYWORDS).toContain("EVENT");
  });

  it("contains window function keywords", () => {
    expect(MYSQL_KEYWORDS).toContain("WINDOW");
    expect(MYSQL_KEYWORDS).toContain("OVER");
    expect(MYSQL_KEYWORDS).toContain("ROWS");
    expect(MYSQL_KEYWORDS).toContain("RANGE");
  });
});

describe("MYSQL_FUNCTIONS", () => {
  it("contains aggregate functions", () => {
    const names = MYSQL_FUNCTIONS.map((f) => f.name);
    expect(names).toContain("COUNT");
    expect(names).toContain("SUM");
    expect(names).toContain("AVG");
    expect(names).toContain("MAX");
    expect(names).toContain("MIN");
  });

  it("contains date/time functions", () => {
    const names = MYSQL_FUNCTIONS.map((f) => f.name);
    expect(names).toContain("NOW");
    expect(names).toContain("CURDATE");
    expect(names).toContain("DATE_FORMAT");
    expect(names).toContain("DATEDIFF");
  });

  it("contains string functions", () => {
    const names = MYSQL_FUNCTIONS.map((f) => f.name);
    expect(names).toContain("CONCAT");
    expect(names).toContain("SUBSTRING");
    expect(names).toContain("UPPER");
    expect(names).toContain("LOWER");
    expect(names).toContain("TRIM");
  });

  it("contains null-handling functions", () => {
    const names = MYSQL_FUNCTIONS.map((f) => f.name);
    expect(names).toContain("COALESCE");
    expect(names).toContain("IFNULL");
    expect(names).toContain("NULLIF");
  });

  it("contains JSON functions", () => {
    const names = MYSQL_FUNCTIONS.map((f) => f.name);
    expect(names).toContain("JSON_EXTRACT");
    expect(names).toContain("JSON_OBJECT");
    expect(names).toContain("JSON_ARRAY");
  });

  it("contains math functions", () => {
    const names = MYSQL_FUNCTIONS.map((f) => f.name);
    expect(names).toContain("ROUND");
    expect(names).toContain("FLOOR");
    expect(names).toContain("CEIL");
    expect(names).toContain("ABS");
  });

  it("has detail strings for all functions", () => {
    MYSQL_FUNCTIONS.forEach((fn) => {
      expect(typeof fn.detail).toBe("string");
      expect(fn.detail.length).toBeGreaterThan(0);
    });
  });
});

describe("createCompletionProvider", () => {
  const mockSchemaData: SchemaData = {
    connectionId: "conn-1",
    databases: ["mydb", "testdb"],
    tables: new Map([["mydb", ["users", "orders"]], ["testdb", ["logs"]]]),
    views: new Map([["mydb", ["user_view"]]]),
    columns: new Map([["mydb.users", [{ name: "id", data_type: "int", column_type: "int", nullable: false, is_primary_key: true, default_value: undefined, extra: "", comment: ""}]]]),
    fetchTables: vi.fn().mockResolvedValue([]),
    fetchViews: vi.fn().mockResolvedValue([]),
    fetchColumns: vi.fn().mockResolvedValue([]),
  };

  it("creates a provider without throwing", () => {
    const provider = createCompletionProvider(mockMonaco, mockSchemaData);
    expect(provider).toBeDefined();
    expect(provider.triggerCharacters).toContain(".");
    expect(provider.triggerCharacters).toContain(" ");
    expect(typeof provider.provideCompletionItems).toBe("function");
  });

  it("provides database suggestions in general context", async () => {
    const provider = createCompletionProvider(mockMonaco, mockSchemaData);
    const model = makeMockModel("", "SELECT * FROM ", 1, 1);
    const result = await provider.provideCompletionItems!(model, makeMockPosition());

    expect(result).not.toBeNull();
    const suggestions = result!.suggestions;
    const labels = suggestions.map((s) => s.label);
    expect(labels).toContain("mydb");
    expect(labels).toContain("testdb");
  });

  it("provides keyword suggestions in general context", async () => {
    const provider = createCompletionProvider(mockMonaco, mockSchemaData);
    const model = makeMockModel("", "", 1, 1);
    const result = await provider.provideCompletionItems!(model, makeMockPosition());

    const suggestions = result!.suggestions;
    const keywordItems = suggestions.filter(
      (s) => s.kind === mockMonaco.languages.CompletionItemKind.Keyword,
    );
    expect(keywordItems.length).toBeGreaterThan(0);
    expect(keywordItems.some((k) => k.label === "SELECT")).toBe(true);
  });

  it("provides function suggestions in general context", async () => {
    const provider = createCompletionProvider(mockMonaco, mockSchemaData);
    const model = makeMockModel("", "", 1, 1);
    const result = await provider.provideCompletionItems!(model, makeMockPosition());

    const suggestions = result!.suggestions;
    const fnItems = suggestions.filter(
      (s) => s.kind === mockMonaco.languages.CompletionItemKind.Function,
    );
    expect(fnItems.length).toBeGreaterThan(0);
    expect(fnItems.some((f) => f.label === "COUNT")).toBe(true);
  });

  it("provides table suggestions in table context", async () => {
    const provider = createCompletionProvider(mockMonaco, mockSchemaData);
    const model = makeMockModel("SELECT * FROM ");
    const result = await provider.provideCompletionItems!(model, makeMockPosition());

    const suggestions = result!.suggestions;
    const tableItems = suggestions.filter(
      (s) => s.kind === mockMonaco.languages.CompletionItemKind.Enum,
    );
    expect(tableItems.some((t) => t.label === "users")).toBe(true);
    expect(tableItems.some((t) => t.label === "orders")).toBe(true);
  });

  it("provides view suggestions in table context", async () => {
    const provider = createCompletionProvider(mockMonaco, mockSchemaData);
    const model = makeMockModel("SELECT * FROM ");
    const result = await provider.provideCompletionItems!(model, makeMockPosition());

    const suggestions = result!.suggestions;
    const viewItems = suggestions.filter(
      (s) => s.kind === mockMonaco.languages.CompletionItemKind.Interface,
    );
    expect(viewItems.some((v) => v.label === "user_view")).toBe(true);
  });

  it("provides column suggestions in column context with FROM tables", async () => {
    const provider = createCompletionProvider(mockMonaco, mockSchemaData);
    const model = makeMockModel(
      "SELECT ",
      "SELECT * FROM users WHERE ",
    );
    const result = await provider.provideCompletionItems!(model, makeMockPosition());

    expect(result).not.toBeNull();
    const suggestions = result!.suggestions;
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("handles dot prefix for database → suggests tables", async () => {
    const fetchTables = vi.fn().mockResolvedValue(["users", "logs"]);
    const schemaData: SchemaData = {
      ...mockSchemaData,
      databases: ["mydb"],
      fetchTables,
    };

    const provider = createCompletionProvider(mockMonaco, schemaData);
    const model = makeMockModel("mydb.", "SELECT * FROM mydb.", 1, 6);
    const result = await provider.provideCompletionItems!(
      model,
      makeMockPosition(1, 6),
    );

    expect(fetchTables).toHaveBeenCalledWith("conn-1", "mydb");
    const suggestions = result!.suggestions;
    expect(suggestions.some((s) => s.label === "users")).toBe(true);
  });

  it("handles dot prefix for table → suggests columns", async () => {
    const fetchColumns = vi.fn().mockResolvedValue([
      { name: "id", data_type: "int", column_type: "int", nullable: false, is_primary_key: true, default_value: undefined, extra: "", comment: "" },
      { name: "name", data_type: "varchar", column_type: "varchar(255)", nullable: true, is_primary_key: false, default_value: undefined, extra: "", comment: "" },
    ]);
    const schemaData: SchemaData = {
      ...mockSchemaData,
      fetchColumns,
    };

    const provider = createCompletionProvider(mockMonaco, schemaData);
    const model = makeMockModel("users.", "SELECT * FROM users.", 1, 7);
    const result = await provider.provideCompletionItems!(
      model,
      makeMockPosition(1, 7),
    );

    const suggestions = result!.suggestions;
    const fieldLabels = suggestions
      .filter((s) => s.kind === mockMonaco.languages.CompletionItemKind.Field)
      .map((s) => s.label);
    expect(fieldLabels).toContain("id");
    expect(fieldLabels).toContain("name");
  });

  it("returns empty suggestions for unknown dot prefix", async () => {
    const provider = createCompletionProvider(mockMonaco, mockSchemaData);
    const model = makeMockModel("unknown.", "", 1, 9);
    const result = await provider.provideCompletionItems!(
      model,
      makeMockPosition(1, 9),
    );

    expect(result!.suggestions).toEqual([]);
  });

  it("handles connectionId being null gracefully", async () => {
    const schemaData: SchemaData = { ...mockSchemaData, connectionId: null };
    const provider = createCompletionProvider(mockMonaco, schemaData);
    const model = makeMockModel("SELECT ");
    const result = await provider.provideCompletionItems!(model, makeMockPosition());

    // Should still return keyword/function suggestions
    expect(result!.suggestions.length).toBeGreaterThan(0);
  });
});
