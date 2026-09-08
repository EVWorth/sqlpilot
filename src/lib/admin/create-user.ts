import type { ServerFlavour } from "../server-flavour";
import { quoteStringLiteral } from "../sql-quote";

/**
 * Building CREATE USER, which is not portable between the two servers.
 *
 * The dialog emitted `IDENTIFIED WITH <plugin> BY '<password>'` regardless of
 * which server was connected. MariaDB rejects that outright — for both
 * plugins the dialog offered — so creating a user against MariaDB failed
 * every time. Verified against MariaDB 11 and MySQL 8:
 *
 *   MariaDB  IDENTIFIED WITH caching_sha2_password BY 'pw'  ERROR 1064
 *   MariaDB  IDENTIFIED WITH mysql_native_password BY 'pw'  ERROR 1064
 *   MariaDB  IDENTIFIED VIA mysql_native_password USING PASSWORD('pw')  ok
 *   MariaDB  IDENTIFIED BY 'pw'                             ok
 *   MySQL 8  IDENTIFIED WITH caching_sha2_password BY 'pw'  ok
 *
 * caching_sha2_password is not merely spelled differently on MariaDB — it
 * does not exist there. Its active authentication plugins are
 * mysql_native_password, mysql_old_password and unix_socket (#561).
 *
 * WITH MAX_USER_CONNECTIONS and ACCOUNT LOCK are accepted by both, and were
 * never the problem.
 */

/** Letting the server pick, which is the portable answer. */
export const SERVER_DEFAULT_PLUGIN = "";

export interface AuthPluginChoice {
  /** The plugin name, or SERVER_DEFAULT_PLUGIN for "let the server decide". */
  value: string;
  label: string;
}

/** The plugins worth offering for this server. */
export function authPluginsFor(flavour: ServerFlavour): AuthPluginChoice[] {
  const serverDefault = { value: SERVER_DEFAULT_PLUGIN, label: "Server default" };
  if (flavour === "mariadb") {
    // Deliberately short. caching_sha2_password is absent on MariaDB, and
    // offering a plugin the server does not implement only moves the failure
    // from parse time to execution time.
    return [serverDefault, { value: "mysql_native_password", label: "mysql_native_password" }];
  }
  return [
    serverDefault,
    { value: "caching_sha2_password", label: "caching_sha2_password" },
    { value: "mysql_native_password", label: "mysql_native_password" },
  ];
}

export interface CreateUserOptions {
  username: string;
  host: string;
  password: string;
  authPlugin: string;
  maxConnections?: number;
  accountLocked?: boolean;
  flavour: ServerFlavour;
}

export function buildCreateUser(opts: CreateUserOptions): string {
  const account = `${quoteStringLiteral(opts.username)}@${quoteStringLiteral(opts.host)}`;
  const parts = [`CREATE USER ${account}`, identifiedClause(opts)];

  if (opts.maxConnections !== undefined && opts.maxConnections > 0) {
    parts.push(`WITH MAX_USER_CONNECTIONS ${opts.maxConnections}`);
  }
  if (opts.accountLocked) {
    parts.push("ACCOUNT LOCK");
  }
  return parts.join("\n  ") + ";";
}

function identifiedClause(opts: CreateUserOptions): string {
  const password = quoteStringLiteral(opts.password);
  if (opts.authPlugin === SERVER_DEFAULT_PLUGIN) {
    return `IDENTIFIED BY ${password}`;
  }
  if (opts.flavour === "mariadb") {
    // MariaDB's spelling. PASSWORD() hashes for the named plugin, which is
    // what USING expects — it stores an authentication string, not a
    // plaintext one.
    return `IDENTIFIED VIA ${opts.authPlugin} USING PASSWORD(${password})`;
  }
  return `IDENTIFIED WITH ${opts.authPlugin} BY ${password}`;
}
