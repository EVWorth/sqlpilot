import { describe, expect, it } from "vitest";
import { authPluginsFor, buildCreateUser, SERVER_DEFAULT_PLUGIN } from "../create-user";

const base = {
  username: "alice",
  host: "%",
  password: "pw",
  authPlugin: SERVER_DEFAULT_PLUGIN,
  flavour: "mysql" as const,
};

describe("buildCreateUser", () => {
  it("uses the portable form when the server picks the plugin", () => {
    // The only IDENTIFIED clause both servers accept.
    expect(buildCreateUser(base)).toContain("IDENTIFIED BY 'pw'");
  });

  it("uses MySQL's plugin syntax on MySQL", () => {
    expect(buildCreateUser({ ...base, authPlugin: "caching_sha2_password" }))
      .toContain("IDENTIFIED WITH caching_sha2_password BY 'pw'");
  });

  it("uses MariaDB's plugin syntax on MariaDB", () => {
    // `IDENTIFIED WITH <plugin> BY` is ERROR 1064 there, whichever plugin is
    // named — confirmed against MariaDB 11 (#561).
    const sql = buildCreateUser({
      ...base,
      flavour: "mariadb",
      authPlugin: "mysql_native_password",
    });
    expect(sql).toContain("IDENTIFIED VIA mysql_native_password USING PASSWORD('pw')");
    expect(sql).not.toContain("IDENTIFIED WITH");
  });

  it("quotes the account and the password", () => {
    const sql = buildCreateUser({ ...base, username: "o'brien", password: "pa\\ss" });
    expect(sql).toContain("CREATE USER 'o''brien'@'%'");
    // The backslash is doubled, or MySQL stores a password nobody typed.
    expect(sql).toContain("'pa\\\\ss'");
  });

  it("adds the optional clauses, which both servers accept", () => {
    const sql = buildCreateUser({ ...base, maxConnections: 5, accountLocked: true });
    expect(sql).toContain("WITH MAX_USER_CONNECTIONS 5");
    expect(sql).toContain("ACCOUNT LOCK");
  });

  it("leaves out a connection limit that was not given or is not positive", () => {
    expect(buildCreateUser(base)).not.toContain("MAX_USER_CONNECTIONS");
    expect(buildCreateUser({ ...base, maxConnections: 0 })).not.toContain("MAX_USER_CONNECTIONS");
  });

  it("ends with a single semicolon", () => {
    const sql = buildCreateUser({ ...base, maxConnections: 5, accountLocked: true });
    expect(sql.endsWith(";")).toBe(true);
    expect(sql.match(/;/g)).toHaveLength(1);
  });
});

describe("authPluginsFor", () => {
  it("does not offer caching_sha2_password on MariaDB, which lacks it", () => {
    // Its active authentication plugins are mysql_native_password,
    // mysql_old_password and unix_socket. Offering one the server does not
    // implement moves the failure from parse time to execution time.
    const values = authPluginsFor("mariadb").map((p) => p.value);
    expect(values).not.toContain("caching_sha2_password");
    expect(values).toContain("mysql_native_password");
  });

  it("offers it on MySQL", () => {
    expect(authPluginsFor("mysql").map((p) => p.value)).toContain("caching_sha2_password");
  });

  it("offers the server default first on both", () => {
    for (const flavour of ["mysql", "mariadb"] as const) {
      expect(authPluginsFor(flavour)[0].value).toBe(SERVER_DEFAULT_PLUGIN);
    }
  });
});
