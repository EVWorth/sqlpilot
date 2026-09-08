/**
 * Which server is on the other end.
 *
 * MySQL and MariaDB diverge in more places than their shared ancestry
 * suggests, and the differences are not always additive — some statements
 * that MySQL accepts are syntax errors on MariaDB rather than no-ops. The
 * backend already branches this way for EXPLAIN ANALYZE (#422); this is the
 * same question asked from the frontend, where `ConnectionInfo` carries the
 * version string the server reported at connect time.
 */

export type ServerFlavour = "mysql" | "mariadb";

/**
 * MariaDB puts its name in `@@version` — "11.4.2-MariaDB-ubu2404" — where
 * MySQL reports a bare version. Anything unrecognised is treated as MySQL,
 * which is the assumption the whole app already makes.
 */
export function serverFlavour(serverVersion: string | null | undefined): ServerFlavour {
  return serverVersion && /mariadb/i.test(serverVersion) ? "mariadb" : "mysql";
}
