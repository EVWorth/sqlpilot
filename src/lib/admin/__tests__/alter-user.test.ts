import { describe, expect, it } from "vitest";
import { buildAlterUserStatements } from "../alter-user";

const target = { username: "app", host: "%" };

describe("buildAlterUserStatements (#436)", () => {
  it("emits nothing when nothing was asked for", () => {
    // Anything else would restate values it was not given — and on MariaDB
    // the panel cannot read lock or expiry state, so it would be guessing.
    expect(buildAlterUserStatements(target)).toEqual([]);
  });

  it("locks an account", () => {
    expect(buildAlterUserStatements({ ...target, lock: "lock" })).toEqual([
      "ALTER USER 'app'@'%' ACCOUNT LOCK",
    ]);
  });

  it("unlocks an account", () => {
    expect(buildAlterUserStatements({ ...target, lock: "unlock" })).toEqual([
      "ALTER USER 'app'@'%' ACCOUNT UNLOCK",
    ]);
  });

  it("expires a password now", () => {
    expect(buildAlterUserStatements({ ...target, expiry: "now" })).toEqual([
      "ALTER USER 'app'@'%' PASSWORD EXPIRE",
    ]);
  });

  it("exempts a password from expiry", () => {
    expect(buildAlterUserStatements({ ...target, expiry: "never" })).toEqual([
      "ALTER USER 'app'@'%' PASSWORD EXPIRE NEVER",
    ]);
  });

  it("hands expiry back to the server default", () => {
    expect(buildAlterUserStatements({ ...target, expiry: "default" })).toEqual([
      "ALTER USER 'app'@'%' PASSWORD EXPIRE DEFAULT",
    ]);
  });

  it("sets an expiry interval", () => {
    expect(buildAlterUserStatements({ ...target, expiry: { days: 90 } })).toEqual([
      "ALTER USER 'app'@'%' PASSWORD EXPIRE INTERVAL 90 DAY",
    ]);
  });

  it("floors a fractional interval and never emits zero days", () => {
    expect(buildAlterUserStatements({ ...target, expiry: { days: 0 } })[0]).toContain("INTERVAL 1 DAY");
    expect(buildAlterUserStatements({ ...target, expiry: { days: 90.7 } })[0]).toContain("INTERVAL 90 DAY");
  });

  it("sets a connection limit, with zero meaning unlimited", () => {
    expect(buildAlterUserStatements({ ...target, maxConnections: 5 })).toEqual([
      "ALTER USER 'app'@'%' WITH MAX_USER_CONNECTIONS 5",
    ]);
    expect(buildAlterUserStatements({ ...target, maxConnections: 0 })).toEqual([
      "ALTER USER 'app'@'%' WITH MAX_USER_CONNECTIONS 0",
    ]);
  });

  it("renames when the host changes", () => {
    expect(buildAlterUserStatements({ ...target, newHost: "localhost" })).toEqual([
      "RENAME USER 'app'@'%' TO 'app'@'localhost'",
    ]);
  });

  it("does not rename to the host it already has", () => {
    expect(buildAlterUserStatements({ ...target, newHost: "%" })).toEqual([]);
  });

  it("puts the rename last, so the others still find the user", () => {
    const statements = buildAlterUserStatements({
      ...target,
      lock: "lock",
      newHost: "localhost",
    });

    expect(statements[0]).toContain("ACCOUNT LOCK");
    expect(statements[1]).toContain("RENAME USER");
    // Every statement before the rename addresses the old host.
    expect(statements[0]).toContain("'app'@'%'");
  });

  it("emits one statement per change rather than combining them", () => {
    // Both servers reject `ACCOUNT LOCK ... WITH MAX_USER_CONNECTIONS`: the
    // resource clause has to come first. Separate statements sidestep the
    // ordering entirely and can be reported one by one when one fails.
    const statements = buildAlterUserStatements({
      ...target,
      lock: "lock",
      expiry: "never",
      maxConnections: 5,
    });

    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s).toMatch(/^ALTER USER 'app'@'%' /);
  });

  it("quotes a user and host that would otherwise break out", () => {
    const [statement] = buildAlterUserStatements({
      username: "o'brien",
      host: "10.0.0.1",
      lock: "lock",
    });

    expect(statement).toBe("ALTER USER 'o\\'brien'@'10.0.0.1' ACCOUNT LOCK");
  });
});
