import { describe, expect, it } from "vitest";
import { parseColumnType, parseOnUpdate } from "../column-modifiers";

describe("parseColumnType", () => {
  it("keeps UNSIGNED and ZEROFILL, which used to be discarded", () => {
    // information_schema reports them inside COLUMN_TYPE, after the length.
    expect(parseColumnType("int(10) unsigned zerofill")).toEqual({
      baseType: "INT",
      length: "10",
      unsigned: true,
      zerofill: true,
    });
  });

  it("reads UNSIGNED without ZEROFILL", () => {
    expect(parseColumnType("bigint(20) unsigned")).toEqual({
      baseType: "BIGINT",
      length: "20",
      unsigned: true,
      zerofill: false,
    });
  });

  it("reads a plain type", () => {
    expect(parseColumnType("varchar(255)")).toEqual({
      baseType: "VARCHAR",
      length: "255",
      unsigned: false,
      zerofill: false,
    });
  });

  it("reads a type with no length at all", () => {
    expect(parseColumnType("timestamp")).toEqual({
      baseType: "TIMESTAMP",
      length: "",
      unsigned: false,
      zerofill: false,
    });
  });

  it("keeps a DECIMAL's precision and scale together", () => {
    expect(parseColumnType("decimal(10,2) unsigned").length).toBe("10,2");
  });

  it("keeps an ENUM whose members contain a bracket", () => {
    // Matched to the last closing bracket for exactly this reason.
    expect(parseColumnType("enum('a)','b')").length).toBe("'a)','b'");
  });

  it("does not mistake a member value for an attribute", () => {
    const parsed = parseColumnType("enum('unsigned','zerofill')");
    expect(parsed.unsigned).toBe(false);
    expect(parsed.zerofill).toBe(false);
  });
});

describe("parseOnUpdate", () => {
  it("takes only the ON UPDATE half of EXTRA", () => {
    // The DEFAULT_GENERATED part describes the DEFAULT and must not be
    // re-emitted as part of the ON UPDATE clause.
    expect(parseOnUpdate("DEFAULT_GENERATED on update CURRENT_TIMESTAMP"))
      .toBe("CURRENT_TIMESTAMP");
  });

  it("reads MariaDB's spelling", () => {
    // MariaDB 11 reports it lowercased and called as a function.
    expect(parseOnUpdate("on update current_timestamp()")).toBe("current_timestamp()");
  });

  it("is empty when there is no ON UPDATE", () => {
    expect(parseOnUpdate("auto_increment")).toBe("");
    expect(parseOnUpdate("")).toBe("");
  });
});
