import { describe, expect, it } from "vitest";
import { describeTotal, planCount } from "../row-count";

describe("row-count (#402)", () => {
  describe("planCount", () => {
    it("uses the engine's own estimate for a whole-table read", () => {
      // information_schema already holds it, so the common case costs nothing.
      const plan = planCount("SELECT * FROM users", "shop");
      expect(plan.kind).toBe("table");
      if (plan.kind !== "table") return;
      expect(plan.estimateSql).toContain("information_schema.TABLES");
      expect(plan.estimateSql).toContain("'shop'");
      expect(plan.estimateSql).toContain("'users'");
    });

    it("will not pass off a table estimate as the answer to a filtered query", () => {
      // TABLE_ROWS answers "how big is the table", which is a different
      // question once there is a WHERE clause.
      expect(planCount("SELECT * FROM users WHERE active = 1", "shop").kind).toBe("wrapped");
    });

    it("has no free estimate without a database to look in", () => {
      expect(planCount("SELECT * FROM users", null).kind).toBe("wrapped");
    });

    it("wraps an arbitrary SELECT in a named derived table", () => {
      // MySQL rejects a derived table with no alias.
      const plan = planCount("SELECT a, b FROM x JOIN y ON x.id = y.x_id", "shop");
      expect(plan.kind).toBe("wrapped");
      if (plan.kind === "none") return;
      expect(plan.exactSql).toBe(
        "SELECT COUNT(*) FROM (SELECT a, b FROM x JOIN y ON x.id = y.x_id) AS sqlpilot_count",
      );
    });

    it("drops a trailing semicolon, which cannot appear inside a subquery", () => {
      const plan = planCount("SELECT * FROM users WHERE id > 1;  ", "shop");
      if (plan.kind === "none") return;
      expect(plan.exactSql).not.toContain(";");
    });

    describe("statements it refuses to count", () => {
      it.each([
        ["SHOW TABLES"],
        ["SHOW CREATE TABLE users"],
        ["DESCRIBE users"],
        ["EXPLAIN SELECT * FROM users"],
        ["CALL do_something()"],
        ["USE shop"],
      ])("%s", (sql) => {
        // Each is rejected by the server when wrapped, and a failed count
        // reported as zero would be worse than no count at all.
        const plan = planCount(sql, "shop");
        expect(plan.kind).toBe("none");
        if (plan.kind !== "none") return;
        expect(plan.reason).toMatch(/cannot be counted|no statement/);
      });

      it.each([
        ["SELECT * FROM users FOR UPDATE"],
        ["SELECT * FROM users LOCK IN SHARE MODE"],
        ["SELECT * FROM users INTO OUTFILE '/tmp/x'"],
        ["SELECT id INTO @v FROM users"],
      ])("%s cannot be a subquery", (sql) => {
        const plan = planCount(sql, "shop");
        expect(plan.kind).toBe("none");
        if (plan.kind !== "none") return;
        expect(plan.reason).toMatch(/subquery/);
      });

      it("has nothing to count for an empty statement", () => {
        expect(planCount("   ", "shop").kind).toBe("none");
      });
    });

    it("escapes a quote in a table or database name", () => {
      const plan = planCount("SELECT * FROM `we'ird`", "sh'op");
      if (plan.kind !== "table") return;
      expect(plan.estimateSql).toContain("'sh''op'");
    });
  });

  describe("describeTotal", () => {
    it("says approximately for an estimate", () => {
      // InnoDB samples TABLE_ROWS from the index; calling it exact would make
      // a later exact count look like a bug when the two disagree.
      expect(describeTotal(1000, { value: 50247, exact: false })).toBe(
        "1,000 of approximately 50,247 rows",
      );
    });

    it("drops the hedge once the count is real", () => {
      expect(describeTotal(1000, { value: 50247, exact: true })).toBe("1,000 of 50,247 rows");
    });

    it("says nothing when nothing is known", () => {
      expect(describeTotal(1000, null)).toBeNull();
    });
  });
});
