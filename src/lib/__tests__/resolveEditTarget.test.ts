import { describe, expect, it } from "vitest";
import { resolveEditTarget } from "../sql-generator";

/** Convenience: the table an edit would be written to, or null when refused. */
function target(sql: string): string | null {
  const t = resolveEditTarget(sql);
  return t.editable ? t.table : null;
}

describe("resolveEditTarget", () => {
  it("accepts a plain single-table select", () => {
    expect(target("SELECT * FROM users")).toBe("users");
    expect(target("SELECT id, name FROM `users` WHERE id > 3")).toBe("users");
    expect(target("select * from users order by id limit 10")).toBe("users");
  });

  it("refuses a join, whichever table comes first", () => {
    // The bug: the old code returned "orders" and wrote there, even for an
    // edit to a column belonging to users (#399).
    expect(target("SELECT * FROM orders o JOIN users u ON u.id = o.user_id")).toBeNull();
    expect(target("SELECT * FROM orders LEFT JOIN users ON users.id = orders.user_id")).toBeNull();
    expect(target("SELECT * FROM a INNER JOIN b ON a.id = b.id")).toBeNull();
  });

  it("refuses the comma form of a join", () => {
    expect(target("SELECT * FROM orders, users WHERE users.id = orders.user_id")).toBeNull();
  });

  it("refuses a CTE", () => {
    expect(target("WITH recent AS (SELECT * FROM users) SELECT * FROM recent")).toBeNull();
  });

  it("refuses a subquery in FROM", () => {
    expect(target("SELECT * FROM (SELECT * FROM users) sub")).toBeNull();
  });

  it("refuses a UNION", () => {
    expect(target("SELECT id FROM users UNION SELECT id FROM admins")).toBeNull();
  });

  it("refuses aggregated rows, which do not map to stored rows", () => {
    expect(target("SELECT role, COUNT(*) FROM users GROUP BY role")).toBeNull();
    expect(target("SELECT DISTINCT role FROM users")).toBeNull();
  });

  it("refuses anything that is not a SELECT", () => {
    expect(target("SHOW TABLES")).toBeNull();
    expect(target("DESCRIBE users")).toBeNull();
    expect(target("UPDATE users SET a = 1")).toBeNull();
  });

  it("refuses more than one statement", () => {
    expect(target("SELECT * FROM users; SELECT * FROM orders")).toBeNull();
  });

  it("is not fooled by keywords inside string literals", () => {
    // A literal mentioning JOIN must not make an ordinary query unsaveable,
    // and one mentioning FROM must not become the table.
    expect(target("SELECT * FROM users WHERE note = 'inner join stuff'")).toBe("users");
    expect(target("SELECT * FROM users WHERE note = 'union all'")).toBe("users");
  });

  it("is not fooled by keywords inside comments", () => {
    expect(target("SELECT * FROM users -- JOIN orders")).toBe("users");
    expect(target("SELECT * /* UNION */ FROM users")).toBe("users");
  });

  it("gives a reason when it refuses", () => {
    const t = resolveEditTarget("SELECT * FROM a JOIN b ON a.id = b.id");
    expect(t.editable).toBe(false);
    if (!t.editable) expect(t.reason).toMatch(/join/i);
  });

  it("refuses an empty query rather than guessing", () => {
    expect(target("")).toBeNull();
    expect(target("   ")).toBeNull();
  });
});
