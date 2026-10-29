import { describe, expect, it } from "vitest";
import { transactionAfter, transactionEffect } from "../transaction-tracking";

describe("transactionEffect (#843)", () => {
  it.each(
    [
      ["BEGIN", true],
      ["begin work;", true],
      ["START TRANSACTION READ ONLY", true],
      ["/* go */ start transaction", true],
      ["COMMIT", false],
      ["ROLLBACK;", false],
      ["COMMIT AND CHAIN", true],
      ["ROLLBACK TO SAVEPOINT a", null],
      ["SET autocommit = 0", true],
      ["SET @@session.autocommit=1", false],
      ["ALTER TABLE t ADD c INT", false],
      ["UPDATE t SET a = 1", null],
      ["SELECT 1", null],
      ["BEGIN NOT ATOMIC SELECT 1; END", null],
    ] as const,
  )("%j -> %j", (sql, effect) => {
    expect(transactionEffect(sql)).toBe(effect);
  });
});

describe("transactionAfter", () => {
  it("follows the statements in order", () => {
    expect(transactionAfter(["BEGIN", "UPDATE t SET a = 1"], false)).toBe(true);
    expect(transactionAfter(["BEGIN", "UPDATE t SET a = 1", "COMMIT"], false)).toBe(false);
  });

  it("keeps the state before when nothing changes it", () => {
    expect(transactionAfter(["UPDATE t SET a = 1"], true)).toBe(true);
    expect(transactionAfter(["SELECT 1"], false)).toBe(false);
  });
});
