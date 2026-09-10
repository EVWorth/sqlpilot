import type { ServerFlavour } from "../server-flavour";
import { quoteStringLiteral } from "../sql-quote";

/**
 * Roles, which the two servers implement differently at almost every point.
 *
 * FR-7.1.6 asks for role management. There was none — no CREATE ROLE, no
 * parsing, no UI (#435). Everything below was checked against MySQL 8.0.46 and
 * MariaDB 11 rather than taken from either vendor's manual, because the manuals
 * agree only on the parts that do not matter:
 *
 *                                        MySQL 8      MariaDB 11
 *   CREATE ROLE / DROP ROLE              ok           ok
 *   GRANT priv TO role                   ok           ok
 *   GRANT role TO user                   ok           ok
 *   REVOKE role FROM user                ok           ok
 *   mysql.user.is_role                   absent       present
 *   mysql.role_edges                     present      absent
 *   mysql.roles_mapping                  absent       present
 *   SET DEFAULT ROLE 'r' TO 'u'@'h'      ok           ERROR 1064
 *   SET DEFAULT ROLE r FOR u@'h'         ERROR 1064   ok
 *
 * The two default-role spellings are exactly inverted, which is the sort of
 * thing that ships broken on one server if only the other is to hand.
 */

/** A role, and who holds it. */
export interface RoleInfo {
  name: string;
  /** MariaDB roles have no host; MySQL's are '%' unless told otherwise. */
  host: string;
}

export interface RoleGrant {
  role: string;
  user: string;
  host: string;
}

/**
 * The query listing roles.
 *
 * MariaDB flags them. MySQL does not: `CREATE ROLE` makes an ordinary account
 * that is locked, expired and passwordless, and that combination is the only
 * way to recognise one. A human account left in all three states would be
 * indistinguishable — rare, and better than not listing roles at all, but it
 * is a heuristic rather than a fact.
 */
export function listRolesQuery(flavour: ServerFlavour): string {
  if (flavour === "mariadb") {
    return "SELECT User AS name, '' AS host FROM mysql.user WHERE is_role = 'Y' ORDER BY User";
  }
  return "SELECT User AS name, Host AS host FROM mysql.user "
    + "WHERE account_locked = 'Y' AND password_expired = 'Y' AND authentication_string = '' "
    + "ORDER BY User, Host";
}

/** The query listing which users hold which roles. */
export function listRoleGrantsQuery(flavour: ServerFlavour): string {
  if (flavour === "mariadb") {
    return "SELECT Role AS role, User AS user, Host AS host FROM mysql.roles_mapping "
      + "WHERE User <> '' ORDER BY Role, User";
  }
  return "SELECT FROM_USER AS role, TO_USER AS user, TO_HOST AS host FROM mysql.role_edges "
    + "ORDER BY FROM_USER, TO_USER";
}

/** `'name'` or `'name'@'host'`, as this server spells a role. */
function roleSpec(role: RoleInfo): string {
  return role.host
    ? `${quoteStringLiteral(role.name)}@${quoteStringLiteral(role.host)}`
    : quoteStringLiteral(role.name);
}

function userSpec(user: string, host: string): string {
  return `${quoteStringLiteral(user)}@${quoteStringLiteral(host)}`;
}

export function buildCreateRole(name: string): string {
  return `CREATE ROLE ${quoteStringLiteral(name)}`;
}

export function buildDropRole(role: RoleInfo): string {
  return `DROP ROLE ${roleSpec(role)}`;
}

export function buildGrantRole(role: RoleInfo, user: string, host: string): string {
  return `GRANT ${roleSpec(role)} TO ${userSpec(user, host)}`;
}

export function buildRevokeRole(role: RoleInfo, user: string, host: string): string {
  return `REVOKE ${roleSpec(role)} FROM ${userSpec(user, host)}`;
}

/**
 * Make a role active on login.
 *
 * The two spellings are inverted between the servers — TO on MySQL, FOR on
 * MariaDB — and each rejects the other's outright.
 */
export function buildSetDefaultRole(
  role: RoleInfo,
  user: string,
  host: string,
  flavour: ServerFlavour,
): string {
  if (flavour === "mariadb") {
    return `SET DEFAULT ROLE ${quoteStringLiteral(role.name)} FOR ${userSpec(user, host)}`;
  }
  return `SET DEFAULT ROLE ${roleSpec(role)} TO ${userSpec(user, host)}`;
}

/** Clear whatever role a user gets on login. */
export function buildClearDefaultRole(
  user: string,
  host: string,
  flavour: ServerFlavour,
): string {
  return flavour === "mariadb"
    ? `SET DEFAULT ROLE NONE FOR ${userSpec(user, host)}`
    : `SET DEFAULT ROLE NONE TO ${userSpec(user, host)}`;
}
