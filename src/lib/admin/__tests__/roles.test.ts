import { describe, expect, it } from "vitest";
import {
  buildClearDefaultRole,
  buildCreateRole,
  buildDropRole,
  buildGrantRole,
  buildRevokeRole,
  buildSetDefaultRole,
  listRoleGrantsQuery,
  listRolesQuery,
} from "../roles";

const mysqlRole = { name: "reader", host: "%" };
const mariaRole = { name: "reader", host: "" };

describe("listRolesQuery (#435)", () => {
  it("uses MariaDB's is_role flag", () => {
    expect(listRolesQuery("mariadb")).toContain("is_role = 'Y'");
  });

  it("uses MySQL's locked-expired-passwordless convention", () => {
    // MySQL has no is_role. CREATE ROLE makes an ordinary account in all
    // three states, and that combination is the only way to recognise one.
    const q = listRolesQuery("mysql");
    expect(q).toContain("account_locked = 'Y'");
    expect(q).toContain("password_expired = 'Y'");
    expect(q).toContain("authentication_string = ''");
    expect(q).not.toContain("is_role");
  });
});

describe("listRoleGrantsQuery", () => {
  it("reads role_edges on MySQL", () => {
    expect(listRoleGrantsQuery("mysql")).toContain("mysql.role_edges");
  });

  it("reads roles_mapping on MariaDB", () => {
    // MariaDB has no role_edges, and MySQL has no roles_mapping.
    expect(listRoleGrantsQuery("mariadb")).toContain("mysql.roles_mapping");
  });
});

describe("role statements", () => {
  it("creates and drops", () => {
    expect(buildCreateRole("reader")).toBe("CREATE ROLE 'reader'");
    expect(buildDropRole(mysqlRole)).toBe("DROP ROLE 'reader'@'%'");
  });

  it("drops a MariaDB role without a host", () => {
    // MariaDB roles have no host component at all.
    expect(buildDropRole(mariaRole)).toBe("DROP ROLE 'reader'");
  });

  it("grants and revokes", () => {
    expect(buildGrantRole(mysqlRole, "app", "%")).toBe("GRANT 'reader'@'%' TO 'app'@'%'");
    expect(buildRevokeRole(mariaRole, "app", "%")).toBe("REVOKE 'reader' FROM 'app'@'%'");
  });

  it("escapes a name that would otherwise break out", () => {
    expect(buildCreateRole("o'brien")).toBe("CREATE ROLE 'o''brien'");
  });
});

describe("buildSetDefaultRole", () => {
  it("says TO on MySQL", () => {
    expect(buildSetDefaultRole(mysqlRole, "app", "%", "mysql"))
      .toBe("SET DEFAULT ROLE 'reader'@'%' TO 'app'@'%'");
  });

  it("says FOR on MariaDB", () => {
    // The two spellings are inverted, and each server rejects the other's.
    expect(buildSetDefaultRole(mariaRole, "app", "%", "mariadb"))
      .toBe("SET DEFAULT ROLE 'reader' FOR 'app'@'%'");
  });

  it("never sends the other server's spelling", () => {
    expect(buildSetDefaultRole(mysqlRole, "app", "%", "mysql")).not.toContain(" FOR ");
    expect(buildSetDefaultRole(mariaRole, "app", "%", "mariadb")).not.toContain(" TO ");
  });
});

describe("buildClearDefaultRole", () => {
  it("clears with the right keyword per server", () => {
    expect(buildClearDefaultRole("app", "%", "mysql")).toBe("SET DEFAULT ROLE NONE TO 'app'@'%'");
    expect(buildClearDefaultRole("app", "%", "mariadb")).toBe("SET DEFAULT ROLE NONE FOR 'app'@'%'");
  });
});
