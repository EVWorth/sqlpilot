import { describe, expect, it } from "vitest";
import { redactCredentials, REDACTION } from "../sql-redact";

/** Assert the secret is gone and the statement still reads as itself. */
function expectRedacted(sql: string, secret: string) {
  const result = redactCredentials(sql);
  expect(result.redacted).toBe(true);
  expect(result.sql).not.toContain(secret);
  expect(result.sql).toContain(REDACTION);
  return result;
}

describe("redactCredentials", () => {
  describe("the statements that carry a password", () => {
    it("CREATE USER ... IDENTIFIED BY", () => {
      const { sql } = expectRedacted(
        "CREATE USER 'app'@'%' IDENTIFIED BY 's3cret'",
        "s3cret",
      );
      // The user and host are not credentials and stay readable.
      expect(sql).toBe(`CREATE USER 'app'@'%' IDENTIFIED BY ${REDACTION}`);
    });

    it("ALTER USER ... IDENTIFIED BY", () => {
      expectRedacted("ALTER USER 'app'@'localhost' IDENTIFIED BY 'hunter2'", "hunter2");
    });

    it("IDENTIFIED BY PASSWORD '<hash>'", () => {
      expectRedacted("CREATE USER 'a'@'%' IDENTIFIED BY PASSWORD '*ABC123'", "*ABC123");
    });

    it("the plugin form, IDENTIFIED WITH ... BY", () => {
      expectRedacted(
        "CREATE USER 'a'@'%' IDENTIFIED WITH caching_sha2_password BY 'pw'",
        "'pw'",
      );
    });

    it("the plugin form, IDENTIFIED WITH ... AS '<hash>'", () => {
      expectRedacted(
        "CREATE USER 'a'@'%' IDENTIFIED WITH mysql_native_password AS '*DEADBEEF'",
        "*DEADBEEF",
      );
    });

    it("SET PASSWORD = ...", () => {
      expectRedacted("SET PASSWORD FOR 'a'@'%' = 'topsecret'", "topsecret");
    });

    it("the legacy PASSWORD() wrapper", () => {
      expectRedacted("SET PASSWORD = PASSWORD('topsecret')", "topsecret");
    });

    it("GRANT ... IDENTIFIED BY, as MySQL 5.7 allowed", () => {
      expectRedacted(
        "GRANT ALL ON db.* TO 'a'@'%' IDENTIFIED BY 'legacy'",
        "legacy",
      );
    });

    it("replication passwords, under both spellings", () => {
      expectRedacted("CHANGE MASTER TO MASTER_PASSWORD = 'replpw'", "replpw");
      expectRedacted("CHANGE REPLICATION SOURCE TO SOURCE_PASSWORD = 'replpw'", "replpw");
    });

    it("CREATE SERVER options", () => {
      expectRedacted(
        "CREATE SERVER s FOREIGN DATA WRAPPER mysql OPTIONS (USER 'u', PASSWORD 'pw2')",
        "'pw2'",
      );
    });

    it("is case- and whitespace-insensitive about the keywords", () => {
      expectRedacted("create user 'a'@'%'\n  identified   by\n  'lower'", "lower");
    });
  });

  describe("passwords that would escape a naive scan", () => {
    it("one containing a backslash-escaped quote", () => {
      expectRedacted("ALTER USER 'a'@'%' IDENTIFIED BY 'it\\'s mine'", "mine");
    });

    it("one containing a doubled quote", () => {
      expectRedacted("ALTER USER 'a'@'%' IDENTIFIED BY 'it''s mine'", "mine");
    });

    it("one in double quotes", () => {
      expectRedacted("ALTER USER 'a'@'%' IDENTIFIED BY \"s3cret\"", "s3cret");
    });

    it("one containing a semicolon, mid-batch", () => {
      const { sql } = expectRedacted(
        "SELECT 1; ALTER USER 'a'@'%' IDENTIFIED BY 'a;b;c'; SELECT 2",
        "a;b;c",
      );
      expect(sql).toContain("SELECT 1;");
      expect(sql).toContain("SELECT 2");
    });

    it("one that looks like a keyword", () => {
      expectRedacted("ALTER USER 'a'@'%' IDENTIFIED BY 'IDENTIFIED BY'", "'IDENTIFIED BY'");
    });

    it("an unterminated literal, which is redacted rather than trusted", () => {
      const result = redactCredentials("ALTER USER 'a'@'%' IDENTIFIED BY 'half-typed");
      expect(result.redacted).toBe(true);
      expect(result.sql).not.toContain("half-typed");
    });

    it("more than one in a single batch", () => {
      const result = redactCredentials(
        "CREATE USER 'a'@'%' IDENTIFIED BY 'first'; CREATE USER 'b'@'%' IDENTIFIED BY 'second'",
      );
      expect(result.sql).not.toContain("first");
      expect(result.sql).not.toContain("second");
    });
  });

  describe("statements it must leave alone", () => {
    it("an ordinary SELECT", () => {
      const sql = "SELECT * FROM users WHERE name = 'alice'";
      expect(redactCredentials(sql)).toEqual({ sql, redacted: false });
    });

    it("a column that happens to be called password", () => {
      const sql = "SELECT password FROM users WHERE email = 'a@b.c'";
      expect(redactCredentials(sql)).toEqual({ sql, redacted: false });
    });

    it("an UPDATE naming a password column, without a credential keyword", () => {
      // `SET password = '...'` is indistinguishable from `SET PASSWORD = '...'`
      // by keyword alone, so this one IS redacted. Recorded here as the
      // deliberate trade: over-redacting a column write costs a user nothing,
      // under-redacting a credential costs them the password.
      const result = redactCredentials("UPDATE users SET password = 'x' WHERE id = 1");
      expect(result.redacted).toBe(true);
    });

    it("a quoted string after an unrelated keyword", () => {
      const sql = "INSERT INTO audit (action) VALUES ('identified the issue')";
      expect(redactCredentials(sql)).toEqual({ sql, redacted: false });
    });

    it("the keyword inside a comment", () => {
      const sql = "-- IDENTIFIED BY\nSELECT 'kept'";
      expect(redactCredentials(sql)).toEqual({ sql, redacted: false });
    });

    it("the keyword inside a block comment", () => {
      const sql = "/* IDENTIFIED BY */ SELECT 'kept'";
      expect(redactCredentials(sql)).toEqual({ sql, redacted: false });
    });

    it("a backtick identifier holding a quote character", () => {
      const sql = "SELECT `it's odd` FROM t WHERE x = 'plain'";
      expect(redactCredentials(sql)).toEqual({ sql, redacted: false });
    });

    it("a statement with no literals at all", () => {
      const sql = "SHOW GRANTS";
      expect(redactCredentials(sql)).toEqual({ sql, redacted: false });
    });

    it("an empty statement", () => {
      expect(redactCredentials("")).toEqual({ sql: "", redacted: false });
    });
  });

  it("does not alter the statement that runs — it returns a copy", () => {
    const original = "CREATE USER 'a'@'%' IDENTIFIED BY 'pw'";
    redactCredentials(original);
    expect(original).toBe("CREATE USER 'a'@'%' IDENTIFIED BY 'pw'");
  });
});
