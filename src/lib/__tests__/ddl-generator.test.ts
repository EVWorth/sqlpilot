import { describe, expect, it } from "vitest";
import {
  type DesignerColumn,
  type DesignerForeignKey,
  generateAlterTable,
  generateCreateTable,
  type TableDesignerConfig,
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
            makeCol({
              id: "c1",
              name: "status",
              type: "ENUM",
              length: "'active','inactive'",
              autoIncrement: false,
              nullable: true,
            }),
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

describe("column modifiers survive a round-trip", () => {
  // The definitions these produce were run against MySQL 8 and MariaDB 11:
  // both accept them and report the column back unchanged, with the stored
  // value intact. See the integration test of the same name.
  const base = {
    id: "c1",
    name: "big",
    type: "INT",
    length: "10",
    nullable: false,
    defaultValue: "",
    autoIncrement: false,
    comment: "",
  };
  const opts = {
    engine: "InnoDB",
    charset: "utf8mb4",
    collation: "utf8mb4_general_ci",
    autoIncrementStart: "1",
    comment: "",
  };
  const wrap = (columns: typeof base[]) => ({
    tableName: "t",
    database: "d",
    columns,
    indexes: [],
    foreignKeys: [],
    options: opts,
  });

  it("emits UNSIGNED and ZEROFILL as part of the type", () => {
    // Dropping them turned an unsigned column signed. On MySQL 8 in strict
    // mode the ALTER then fails with ERROR 1264 if any row is above
    // 2^31-1; with strict mode off, 4000000000 is clamped to 2147483647
    // (#377). Both confirmed against a live server.
    const col = { ...base, unsigned: true, zerofill: true };
    const sql = generateAlterTable("t", wrap([base]), wrap([{ ...col, comment: "edited" }]));
    expect(sql).toContain("MODIFY COLUMN `big` INT(10) UNSIGNED ZEROFILL NOT NULL");
  });

  it("puts CHARACTER SET and COLLATE after the type, where MySQL wants them", () => {
    const col = {
      ...base,
      name: "s",
      type: "VARCHAR",
      length: "20",
      nullable: true,
      charset: "utf8mb4",
      collation: "utf8mb4_bin",
    };
    const sql = generateAlterTable("t", wrap([base]), wrap([col]));
    expect(sql).toContain("`s` VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL");
  });

  it("emits ON UPDATE after DEFAULT", () => {
    const col = {
      ...base,
      name: "ts",
      type: "TIMESTAMP",
      length: "",
      nullable: true,
      defaultValue: "CURRENT_TIMESTAMP",
      onUpdate: "CURRENT_TIMESTAMP",
    };
    const sql = generateAlterTable("t", wrap([base]), wrap([col]));
    expect(sql).toContain("`ts` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
  });

  it("treats a modifier change as a change worth emitting", () => {
    // Nothing else about the column differs, so without this the request to
    // drop UNSIGNED would diff to nothing.
    const before = { ...base, unsigned: true };
    const after = { ...base, unsigned: false };
    expect(generateAlterTable("t", wrap([before]), wrap([after]))).toContain("MODIFY COLUMN");
  });

  it("says nothing about a column nobody touched", () => {
    const col = { ...base, unsigned: true, zerofill: true };
    expect(generateAlterTable("t", wrap([col]), wrap([col]))).toContain("No changes detected");
  });
});

describe("an ALTER either all applies or none of it does", () => {
  const col = (id: string, name: string) => ({
    id,
    name,
    type: "INT",
    length: "",
    nullable: true,
    defaultValue: "",
    autoIncrement: false,
    comment: "",
  });
  const opts = {
    engine: "InnoDB",
    charset: "utf8mb4",
    collation: "utf8mb4_general_ci",
    autoIncrementStart: "1",
    comment: "",
  };
  const wrap = (columns: ReturnType<typeof col>[], overrides = {}) => ({
    tableName: "t",
    database: "d",
    columns,
    indexes: [],
    foreignKeys: [],
    options: opts,
    ...overrides,
  });

  it("puts every change in one statement", () => {
    // Five separate statements meant a run could stop in the middle: adding
    // five columns where the third collides left the first two added.
    // Verified on MySQL 8 and MariaDB 11 (#379).
    const before = wrap([col("c1", "id")]);
    const after = wrap([
      col("c1", "id"),
      col("c2", "a"),
      col("c3", "b"),
      col("c4", "c"),
    ]);
    const sql = generateAlterTable("t", before, after);

    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(sql.match(/;/g)).toHaveLength(1);
    expect(sql).toContain("ADD COLUMN `a`");
    expect(sql).toContain("ADD COLUMN `c`");
  });

  it("combines a rename, a drop, an add and an option change", () => {
    // All four are legal clauses of one ALTER — checked against both servers.
    const before = wrap([col("c1", "id"), col("c2", "gone")]);
    const after = wrap([col("c1", "id"), col("c3", "added")], {
      tableName: "renamed",
      options: { ...opts, comment: "now commented" },
    });
    const sql = generateAlterTable("t", before, after);

    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(sql).toContain("RENAME TO `renamed`");
    expect(sql).toContain("DROP COLUMN `gone`");
    expect(sql).toContain("ADD COLUMN `added`");
    expect(sql).toContain("COMMENT = 'now commented'");
  });

  it("separates clauses with commas, not semicolons", () => {
    const before = wrap([col("c1", "id")]);
    const after = wrap([col("c1", "id"), col("c2", "a"), col("c3", "b")]);
    const sql = generateAlterTable("t", before, after);

    expect(sql.trimEnd().endsWith(";")).toBe(true);
    expect(sql.slice(0, -1)).not.toContain(";");
    expect(sql).toContain(",");
  });

  it("still says nothing when nothing changed", () => {
    const same = wrap([col("c1", "id")]);
    expect(generateAlterTable("t", same, same)).toContain("No changes detected");
  });
});
