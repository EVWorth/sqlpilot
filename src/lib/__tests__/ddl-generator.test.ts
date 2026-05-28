import { describe, it, expect } from "vitest";
import {
  generateCreateTable,
  generateAlterTable,
  type TableDesignerConfig,
  type DesignerColumn,
  type DesignerForeignKey,
  type TableOptions,
} from "../ddl-generator";

const defaultOptions: TableOptions = {
  engine: "InnoDB",
  charset: "utf8mb4",
  collation: "utf8mb4_general_ci",
  autoIncrementStart: "1",
  comment: "",
};

function makeCol(overrides: Partial<DesignerColumn> = {}): DesignerColumn {
  return {
    id: "col-1",
    name: "id",
    type: "INT",
    length: "",
    nullable: false,
    defaultValue: "",
    autoIncrement: true,
    comment: "",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<TableDesignerConfig> = {}): TableDesignerConfig {
  return {
    tableName: "users",
    database: "testdb",
    columns: [makeCol()],
    indexes: [],
    foreignKeys: [],
    options: { ...defaultOptions },
    ...overrides,
  };
}

describe("ddl-generator", () => {
  describe("generateCreateTable", () => {
    it("generates a basic CREATE TABLE", () => {
      const sql = generateCreateTable(makeConfig());
      expect(sql).toContain("CREATE TABLE `users`");
      expect(sql).toContain("`id` INT NOT NULL AUTO_INCREMENT");
      expect(sql).toContain("ENGINE = InnoDB");
    });

    it("handles VARCHAR with length", () => {
      const sql = generateCreateTable(
        makeConfig({
          columns: [
            makeCol({ id: "c1", name: "name", type: "VARCHAR", length: "255", autoIncrement: false, nullable: true }),
          ],
        }),
      );
      expect(sql).toContain("`name` VARCHAR(255) NULL");
    });

    it("handles ENUM with values", () => {
      const sql = generateCreateTable(
        makeConfig({
          columns: [
            makeCol({ id: "c1", name: "status", type: "ENUM", length: "'active','inactive'", autoIncrement: false, nullable: true }),
          ],
        }),
      );
      expect(sql).toContain("`status` ENUM('active','inactive')");
    });

    it("handles default values", () => {
      const sql = generateCreateTable(
        makeConfig({
          columns: [
            makeCol({
              id: "c1",
              name: "status",
              type: "VARCHAR",
              length: "50",
              autoIncrement: false,
              defaultValue: "active",
            }),
          ],
        }),
      );
      expect(sql).toContain("DEFAULT 'active'");
    });

    it("handles CURRENT_TIMESTAMP default", () => {
      const sql = generateCreateTable(
        makeConfig({
          columns: [
            makeCol({
              id: "c1",
              name: "created_at",
              type: "TIMESTAMP",
              autoIncrement: false,
              nullable: true,
              defaultValue: "CURRENT_TIMESTAMP",
            }),
          ],
        }),
      );
      expect(sql).toContain("DEFAULT CURRENT_TIMESTAMP");
      expect(sql).not.toContain("DEFAULT 'CURRENT_TIMESTAMP'");
    });

    it("handles column comments", () => {
      const sql = generateCreateTable(
        makeConfig({
          columns: [makeCol({ comment: "Primary key" })],
        }),
      );
      expect(sql).toContain("COMMENT 'Primary key'");
    });

    it("includes PRIMARY KEY index", () => {
      const sql = generateCreateTable(
        makeConfig({
          indexes: [{ id: "idx-1", name: "PRIMARY", type: "PRIMARY KEY", columns: ["id"] }],
        }),
      );
      expect(sql).toContain("PRIMARY KEY (`id`)");
    });

    it("includes UNIQUE index", () => {
      const sql = generateCreateTable(
        makeConfig({
          columns: [
            makeCol(),
            makeCol({ id: "c2", name: "email", type: "VARCHAR", length: "255", autoIncrement: false }),
          ],
          indexes: [{ id: "idx-1", name: "idx_email", type: "UNIQUE", columns: ["email"] }],
        }),
      );
      expect(sql).toContain("UNIQUE INDEX `idx_email` (`email`)");
    });

    it("includes foreign keys", () => {
      const fk: DesignerForeignKey = {
        id: "fk-1",
        name: "fk_user",
        columns: ["user_id"],
        referenceTable: "users",
        referenceColumns: ["id"],
        onDelete: "CASCADE",
        onUpdate: "RESTRICT",
      };
      const sql = generateCreateTable(
        makeConfig({
          columns: [makeCol({ id: "c1", name: "user_id", type: "INT", autoIncrement: false })],
          foreignKeys: [fk],
        }),
      );
      expect(sql).toContain("CONSTRAINT `fk_user` FOREIGN KEY (`user_id`)");
      expect(sql).toContain("REFERENCES `users` (`id`)");
      expect(sql).toContain("ON DELETE CASCADE");
      expect(sql).toContain("ON UPDATE RESTRICT");
    });

    it("includes table options", () => {
      const sql = generateCreateTable(
        makeConfig({
          options: { ...defaultOptions, comment: "User table", autoIncrementStart: "100" },
        }),
      );
      expect(sql).toContain("AUTO_INCREMENT = 100");
      expect(sql).toContain("COMMENT = 'User table'");
    });

    it("returns placeholder for empty config", () => {
      const sql = generateCreateTable(
        makeConfig({ tableName: "", columns: [] }),
      );
      expect(sql).toContain("-- Please add");
    });

    it("handles multiple columns", () => {
      const sql = generateCreateTable(
        makeConfig({
          columns: [
            makeCol({ id: "c1", name: "id", type: "INT" }),
            makeCol({ id: "c2", name: "name", type: "VARCHAR", length: "100", autoIncrement: false, nullable: true }),
            makeCol({ id: "c3", name: "email", type: "VARCHAR", length: "255", autoIncrement: false }),
          ],
        }),
      );
      expect(sql).toContain("`id`");
      expect(sql).toContain("`name`");
      expect(sql).toContain("`email`");
    });

    it("escapes single quotes in comment", () => {
      const sql = generateCreateTable(
        makeConfig({
          columns: [makeCol({ comment: "it's a test" })],
        }),
      );
      expect(sql).toContain("COMMENT 'it''s a test'");
    });
  });

  describe("generateAlterTable", () => {
    it("detects added columns", () => {
      const original = makeConfig();
      const modified = makeConfig({
        columns: [
          makeCol(),
          makeCol({ id: "c-new", name: "email", type: "VARCHAR", length: "255", autoIncrement: false }),
        ],
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("ADD COLUMN `email` VARCHAR(255)");
      expect(sql).toContain("AFTER `id`");
    });

    it("detects dropped columns", () => {
      const original = makeConfig({
        columns: [
          makeCol(),
          makeCol({ id: "c2", name: "email", type: "VARCHAR", length: "255", autoIncrement: false }),
        ],
      });
      const modified = makeConfig({
        columns: [makeCol()],
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("DROP COLUMN `email`");
    });

    it("detects modified columns", () => {
      const original = makeConfig({
        columns: [makeCol({ id: "c1", name: "name", type: "VARCHAR", length: "100", autoIncrement: false })],
      });
      const modified = makeConfig({
        columns: [makeCol({ id: "c1", name: "name", type: "VARCHAR", length: "255", autoIncrement: false })],
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("MODIFY COLUMN `name` VARCHAR(255)");
    });

    it("detects renamed columns", () => {
      const original = makeConfig({
        columns: [makeCol({ id: "c1", name: "old_name", type: "VARCHAR", length: "100", autoIncrement: false })],
      });
      const modified = makeConfig({
        columns: [makeCol({ id: "c1", name: "new_name", type: "VARCHAR", length: "100", autoIncrement: false })],
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("CHANGE COLUMN `old_name` `new_name`");
    });

    it("detects table rename", () => {
      const original = makeConfig({ tableName: "users" });
      const modified = makeConfig({ tableName: "accounts" });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("RENAME TO `accounts`");
    });

    it("detects added indexes", () => {
      const original = makeConfig();
      const modified = makeConfig({
        indexes: [{ id: "idx-new", name: "idx_email", type: "INDEX", columns: ["email"] }],
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("ADD INDEX `idx_email` (`email`)");
    });

    it("detects dropped indexes", () => {
      const original = makeConfig({
        indexes: [{ id: "idx-1", name: "idx_email", type: "INDEX", columns: ["email"] }],
      });
      const modified = makeConfig();
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("DROP INDEX `idx_email`");
    });

    it("detects added foreign keys", () => {
      const fk: DesignerForeignKey = {
        id: "fk-new",
        name: "fk_user",
        columns: ["user_id"],
        referenceTable: "users",
        referenceColumns: ["id"],
        onDelete: "CASCADE",
        onUpdate: "RESTRICT",
      };
      const original = makeConfig();
      const modified = makeConfig({ foreignKeys: [fk] });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("ADD CONSTRAINT `fk_user`");
    });

    it("detects dropped foreign keys", () => {
      const fk: DesignerForeignKey = {
        id: "fk-1",
        name: "fk_user",
        columns: ["user_id"],
        referenceTable: "users",
        referenceColumns: ["id"],
        onDelete: "CASCADE",
        onUpdate: "RESTRICT",
      };
      const original = makeConfig({ foreignKeys: [fk] });
      const modified = makeConfig();
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("DROP FOREIGN KEY `fk_user`");
    });

    it("detects option changes", () => {
      const original = makeConfig();
      const modified = makeConfig({
        options: { ...defaultOptions, engine: "MyISAM", comment: "Updated" },
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("ENGINE = MyISAM");
      expect(sql).toContain("COMMENT = 'Updated'");
    });

    it("returns no-changes message when identical", () => {
      const config = makeConfig();
      const sql = generateAlterTable("users", config, config);
      expect(sql).toContain("-- No changes detected");
    });

    it("handles PRIMARY KEY drop", () => {
      const original = makeConfig({
        indexes: [{ id: "pk-1", name: "PRIMARY", type: "PRIMARY KEY", columns: ["id"] }],
      });
      const modified = makeConfig();
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("DROP PRIMARY KEY");
    });

    it("handles CURRENT_TIMESTAMP ON UPDATE default", () => {
      const sql = generateCreateTable(
        makeConfig({
          columns: [
            makeCol({
              id: "c1",
              name: "updated_at",
              type: "TIMESTAMP",
              autoIncrement: false,
              nullable: true,
              defaultValue: "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
            }),
          ],
        }),
      );
      expect(sql).toContain("DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
    });

    it("handles collation option change", () => {
      const original = makeConfig({
        options: { ...defaultOptions, collation: "utf8mb4_general_ci" },
      });
      const modified = makeConfig({
        options: { ...defaultOptions, collation: "utf8mb4_0900_ai_ci" },
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("COLLATE = utf8mb4_0900_ai_ci");
    });

    it("handles charset option change", () => {
      const original = makeConfig({
        options: { ...defaultOptions, charset: "utf8mb4" },
      });
      const modified = makeConfig({
        options: { ...defaultOptions, charset: "utf8mb3" },
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("DEFAULT CHARSET = utf8mb3");
    });

    it("detects modified indexes as drop+add", () => {
      const original = makeConfig({
        columns: [
          makeCol(),
          makeCol({ id: "c2", name: "email", type: "VARCHAR", length: "255", autoIncrement: false }),
        ],
        indexes: [{ id: "idx-1", name: "idx_a", type: "INDEX", columns: ["email"] }],
      });
      const modified = makeConfig({
        columns: [
          makeCol(),
          makeCol({ id: "c2", name: "email", type: "VARCHAR", length: "255", autoIncrement: false }),
        ],
        indexes: [{ id: "idx-1", name: "idx_b", type: "UNIQUE", columns: ["email"] }],
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("DROP INDEX `idx_a`");
      expect(sql).toContain("UNIQUE INDEX `idx_b`");
    });

    it("detects modified PRIMARY KEY", () => {
      const original = makeConfig({
        indexes: [{ id: "pk-1", name: "PRIMARY", type: "PRIMARY KEY", columns: ["id"] }],
      });
      const modified = makeConfig({
        indexes: [{ id: "pk-1", name: "pk_combined", type: "PRIMARY KEY", columns: ["id", "name"] }],
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("DROP PRIMARY KEY");
      expect(sql).toContain("ADD PRIMARY KEY");
    });

    it("detects modified foreign keys as drop+add", () => {
      const fk1: DesignerForeignKey = {
        id: "fk-1",
        name: "fk_ref",
        columns: ["user_id"],
        referenceTable: "users",
        referenceColumns: ["id"],
        onDelete: "CASCADE",
        onUpdate: "RESTRICT",
      };
      const fk2: DesignerForeignKey = {
        id: "fk-1",
        name: "fk_ref_new",
        columns: ["user_id"],
        referenceTable: "accounts",
        referenceColumns: ["id"],
        onDelete: "SET NULL",
        onUpdate: "RESTRICT",
      };
      const original = makeConfig({ foreignKeys: [fk1] });
      const modified = makeConfig({ foreignKeys: [fk2] });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("DROP FOREIGN KEY `fk_ref`");
      expect(sql).toContain("ADD CONSTRAINT");
    });

    it("handles add PRIMARY KEY index", () => {
      const original = makeConfig();
      const modified = makeConfig({
        indexes: [{ id: "pk-new", name: "PRIMARY", type: "PRIMARY KEY", columns: ["id"] }],
      });
      const sql = generateAlterTable("users", original, modified);
      expect(sql).toContain("ADD PRIMARY KEY");
    });

    it("handles FULLTEXT index in CREATE TABLE", () => {
      const sql = generateCreateTable(
        makeConfig({
          columns: [
            makeCol({ id: "c1", name: "id", type: "INT" }),
            makeCol({ id: "c2", name: "description", type: "TEXT", autoIncrement: false, nullable: true }),
          ],
          indexes: [{ id: "ft-1", name: "ft_desc", type: "FULLTEXT", columns: ["description"] }],
        }),
      );
      expect(sql).toContain("FULLTEXT `ft_desc`");
    });
  });
});
