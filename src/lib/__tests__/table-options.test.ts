import { describe, expect, it } from "vitest";
import { DEFAULT_TABLE_OPTIONS, parseTableOptions } from "../table-options";

// Captured from the repo's own containers, MySQL 8 and MariaDB 11, which
// emit an identical options clause for this table.
const NON_DEFAULT = "CREATE TABLE `t_opts` (\n"
  + "  `id` int NOT NULL AUTO_INCREMENT,\n"
  + "  `s` varchar(10) COLLATE utf8mb3_bin DEFAULT NULL,\n"
  + "  PRIMARY KEY (`id`)\n"
  + ") ENGINE=MyISAM AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_bin COMMENT='legacy o''brien'";

const PLAIN = "CREATE TABLE `t_plain` (\n"
  + "  `id` int DEFAULT NULL\n"
  + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

describe("parseTableOptions", () => {
  it("reads what the table actually is", () => {
    expect(parseTableOptions(NON_DEFAULT)).toEqual({
      engine: "MyISAM",
      charset: "utf8mb3",
      collation: "utf8mb3_bin",
      autoIncrementStart: "2",
      comment: "legacy o'brien",
    });
  });

  it("undoubles a quote inside the comment", () => {
    // MySQL writes a single quote as '' in the clause, not \'.
    expect(parseTableOptions(NON_DEFAULT).comment).toBe("legacy o'brien");
  });

  it("reads a table with no comment and no auto-increment", () => {
    expect(parseTableOptions(PLAIN)).toEqual({
      engine: "InnoDB",
      charset: "utf8mb4",
      collation: "utf8mb4_unicode_ci",
      autoIncrementStart: "1",
      comment: "",
    });
  });

  it("keeps MariaDB's own collation naming", () => {
    const mariadb = "CREATE TABLE `t` (\n  `id` int(11) DEFAULT NULL\n"
      + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci";
    expect(parseTableOptions(mariadb).collation).toBe("utf8mb4_uca1400_ai_ci");
  });

  it("is not fooled by a column comment that looks like an options clause", () => {
    // The clause is found from the end for exactly this reason.
    const tricky = "CREATE TABLE `t` (\n"
      + "  `a` int COMMENT 'see\\n) ENGINE=MyISAM COMMENT=''nope'''\n"
      + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
    const opts = parseTableOptions(tricky);
    expect(opts.engine).toBe("InnoDB");
    expect(opts.comment).toBe("");
  });

  it("falls back to the defaults when there is no clause at all", () => {
    expect(parseTableOptions("not a create statement")).toEqual(DEFAULT_TABLE_OPTIONS);
  });
});
