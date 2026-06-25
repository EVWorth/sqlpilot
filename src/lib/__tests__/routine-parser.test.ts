import { describe, expect, it } from "vitest";
import { parseRoutineMetadata, parseRoutineParameters } from "../routine-parser";

describe("parseRoutineParameters", () => {
  it("parses simple IN parameters", () => {
    const ddl = `CREATE PROCEDURE my_proc(IN id INT, IN name VARCHAR(100))
BEGIN
  SELECT * FROM users WHERE id = id;
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      { direction: "IN", name: "id", dataType: "INT" },
      { direction: "IN", name: "name", dataType: "VARCHAR(100)" },
    ]);
  });

  it("parses OUT parameters", () => {
    const ddl = `CREATE PROCEDURE calc(IN id INT, OUT result DECIMAL(10,2))
BEGIN
  SELECT total INTO result FROM orders WHERE order_id = id;
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      { direction: "IN", name: "id", dataType: "INT" },
      { direction: "OUT", name: "result", dataType: "DECIMAL(10,2)" },
    ]);
  });

  it("parses INOUT parameters", () => {
    const ddl = `CREATE PROCEDURE inc(INOUT counter INT)
BEGIN
  SET counter = counter + 1;
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      { direction: "INOUT", name: "counter", dataType: "INT" },
    ]);
  });

  it("handles no parameters", () => {
    const ddl = `CREATE PROCEDURE do_nothing()
BEGIN
  SELECT 1;
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([]);
  });

  it("parses function parameters (no direction keyword)", () => {
    const ddl = `CREATE FUNCTION add_numbers(a INT, b INT)
RETURNS INT
DETERMINISTIC
BEGIN
  RETURN a + b;
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      { direction: "IN", name: "a", dataType: "INT" },
      { direction: "IN", name: "b", dataType: "INT" },
    ]);
  });

  it("parses ENUM type parameters", () => {
    const ddl = `CREATE PROCEDURE set_status(IN status ENUM('active','inactive','pending'))
BEGIN
  UPDATE users SET status = status;
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      {
        direction: "IN",
        name: "status",
        dataType: "ENUM('active','inactive','pending')",
      },
    ]);
  });

  it("parses SET type parameters", () => {
    const ddl = `CREATE PROCEDURE update_perms(IN perms SET('read','write','admin'))
BEGIN
  UPDATE users SET permissions = perms;
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      {
        direction: "IN",
        name: "perms",
        dataType: "SET('read','write','admin')",
      },
    ]);
  });

  it("parses DECIMAL with precision", () => {
    const ddl = `CREATE PROCEDURE calc_tax(IN amount DECIMAL(10,2), IN rate DECIMAL(5,4), OUT tax DECIMAL(10,2))
BEGIN
  SET tax = amount * rate;
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      { direction: "IN", name: "amount", dataType: "DECIMAL(10,2)" },
      { direction: "IN", name: "rate", dataType: "DECIMAL(5,4)" },
      { direction: "OUT", name: "tax", dataType: "DECIMAL(10,2)" },
    ]);
  });

  it("handles DDL with DEFINER clause", () => {
    const ddl = `CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE my_proc(IN id INT)
BEGIN
  SELECT id;
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      { direction: "IN", name: "id", dataType: "INT" },
    ]);
  });

  it("handles backtick-quoted parameter names", () => {
    const ddl = "CREATE PROCEDURE my_proc(IN `order` INT, IN `select` VARCHAR(50))\nBEGIN\n  SELECT 1;\nEND";
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      { direction: "IN", name: "order", dataType: "INT" },
      { direction: "IN", name: "select", dataType: "VARCHAR(50)" },
    ]);
  });

  it("handles mixed direction parameters", () => {
    const ddl =
      `CREATE PROCEDURE transfer(IN from_id INT, IN to_id INT, IN amount DECIMAL(10,2), OUT success BOOLEAN, INOUT log_msg VARCHAR(255))
BEGIN
  SELECT 1;
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      { direction: "IN", name: "from_id", dataType: "INT" },
      { direction: "IN", name: "to_id", dataType: "INT" },
      { direction: "IN", name: "amount", dataType: "DECIMAL(10,2)" },
      { direction: "OUT", name: "success", dataType: "BOOLEAN" },
      { direction: "INOUT", name: "log_msg", dataType: "VARCHAR(255)" },
    ]);
  });

  it("parses function with no parameters", () => {
    const ddl = `CREATE FUNCTION get_version()
RETURNS VARCHAR(20)
DETERMINISTIC
BEGIN
  RETURN '1.0.0';
END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([]);
  });

  it("handles schema-qualified routine name", () => {
    const ddl = "CREATE PROCEDURE `mydb`.`my_proc`(IN id INT)\nBEGIN\n  SELECT id;\nEND";
    const params = parseRoutineParameters(ddl);
    expect(params).toEqual([
      { direction: "IN", name: "id", dataType: "INT" },
    ]);
  });
});

describe("parseRoutineMetadata", () => {
  it("extracts RETURNS type for functions", () => {
    const ddl = `CREATE FUNCTION add_nums(a INT, b INT)
RETURNS INT
DETERMINISTIC
BEGIN
  RETURN a + b;
END`;
    const meta = parseRoutineMetadata(ddl);
    expect(meta.returnsType).toBe("INT");
    expect(meta.isDeterministic).toBe(true);
  });

  it("extracts SQL SECURITY", () => {
    const ddl = `CREATE PROCEDURE my_proc()
SQL SECURITY INVOKER
BEGIN
  SELECT 1;
END`;
    const meta = parseRoutineMetadata(ddl);
    expect(meta.sqlSecurity).toBe("INVOKER");
  });

  it("extracts COMMENT", () => {
    const ddl = `CREATE PROCEDURE my_proc()
COMMENT 'This is a test procedure'
BEGIN
  SELECT 1;
END`;
    const meta = parseRoutineMetadata(ddl);
    expect(meta.comment).toBe("This is a test procedure");
  });

  it("extracts NOT DETERMINISTIC", () => {
    const ddl = `CREATE FUNCTION rand_val()
RETURNS INT
NOT DETERMINISTIC
BEGIN
  RETURN FLOOR(RAND() * 100);
END`;
    const meta = parseRoutineMetadata(ddl);
    expect(meta.isDeterministic).toBe(false);
  });
});
