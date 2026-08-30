import { describe, expect, it } from "vitest";
import { isDestructiveStatement, stripNonExecutable } from "../sql-safety";

describe("isDestructiveStatement", () => {
  it("catches what the original pattern caught", () => {
    expect(isDestructiveStatement("DROP TABLE users")).toBe(true);
    expect(isDestructiveStatement("DELETE FROM users")).toBe(true);
    expect(isDestructiveStatement("TRUNCATE users")).toBe(true);
    expect(isDestructiveStatement("ALTER TABLE users ADD c INT")).toBe(true);
  });

  it("catches what it missed", () => {
    // All irreversible or privilege-changing, none matched before (#415).
    expect(isDestructiveStatement("RENAME TABLE users TO users_old")).toBe(true);
    expect(isDestructiveStatement("GRANT ALL ON *.* TO 'alice'@'%'")).toBe(true);
    expect(isDestructiveStatement("REVOKE ALL ON *.* FROM 'alice'@'%'")).toBe(true);
    expect(isDestructiveStatement("SET PASSWORD FOR 'alice'@'%' = 'x'")).toBe(true);
    expect(isDestructiveStatement("LOCK TABLES users WRITE")).toBe(true);
    expect(isDestructiveStatement("KILL 42")).toBe(true);
    expect(isDestructiveStatement("CREATE USER 'bob'@'%' IDENTIFIED BY 'x'")).toBe(true);
    expect(isDestructiveStatement("DROP USER 'bob'@'%'")).toBe(true);
  });

  it("sees through a conditional comment, which MySQL executes", () => {
    // The subtle one. `/*! ... */` is not a comment to MySQL — it runs the
    // contents — so stripping it like an ordinary comment is exactly how this
    // reads as harmless while dropping the table.
    expect(isDestructiveStatement("/*! DROP */ TABLE users")).toBe(true);
    expect(isDestructiveStatement("/*!40000 DROP TABLE users */")).toBe(true);
  });

  it("does not prompt for ordinary reads", () => {
    expect(isDestructiveStatement("SELECT * FROM users")).toBe(false);
    expect(isDestructiveStatement("SHOW TABLES")).toBe(false);
    expect(isDestructiveStatement("EXPLAIN SELECT * FROM users")).toBe(false);
  });

  it("does not prompt for the ordinary writes a client is for", () => {
    // Prompting on every UPDATE trains people to dismiss the dialog, which
    // costs more than it saves.
    expect(isDestructiveStatement("UPDATE users SET name = 'x' WHERE id = 1")).toBe(false);
    expect(isDestructiveStatement("INSERT INTO users (name) VALUES ('x')")).toBe(false);
  });

  it("is not fooled by a keyword inside a string literal", () => {
    // A false prompt is not free either: it is one more dialog to click past.
    expect(isDestructiveStatement("SELECT * FROM logs WHERE msg = 'DROP TABLE users'")).toBe(false);
    expect(isDestructiveStatement("INSERT INTO notes (body) VALUES ('please revoke access')")).toBe(
      false,
    );
  });

  it("is not fooled by a keyword inside a comment", () => {
    expect(isDestructiveStatement("SELECT 1 -- DROP TABLE users")).toBe(false);
    expect(isDestructiveStatement("SELECT 1 /* TRUNCATE users */")).toBe(false);
    expect(isDestructiveStatement("SELECT 1 # GRANT ALL")).toBe(false);
  });

  it("catches a destructive statement later in a script", () => {
    expect(isDestructiveStatement("SELECT 1; DROP TABLE users;")).toBe(true);
  });
});

describe("stripNonExecutable", () => {
  it("keeps what a conditional comment would run", () => {
    expect(stripNonExecutable("/*!40000 DROP TABLE t */")).toContain("DROP TABLE t");
  });

  it("removes an ordinary comment entirely", () => {
    expect(stripNonExecutable("SELECT 1 /* DROP TABLE t */")).not.toContain("DROP");
  });

  it("empties string literals without dropping the statement around them", () => {
    const out = stripNonExecutable("SELECT * FROM t WHERE a = 'DROP'");
    expect(out).not.toContain("DROP");
    expect(out).toContain("SELECT");
    expect(out).toContain("FROM t");
  });
});
