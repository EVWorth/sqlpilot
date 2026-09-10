import { quoteStringLiteral } from "../sql-quote";

/**
 * Building the ALTER USER statements for an edit.
 *
 * FR-7.1.3 promises password, host, lock and expiry are all editable; only the
 * password ever was, so unlocking an account that had locked itself meant
 * leaving the app and writing SQL (#436).
 *
 * Two things were verified against MySQL 8.0.46 and MariaDB 11 rather than
 * assumed, because the last admin feature shipped broken on MariaDB by
 * assuming (#561):
 *
 *   ACCOUNT LOCK / UNLOCK                    both ok
 *   PASSWORD EXPIRE / NEVER / DEFAULT        both ok
 *   PASSWORD EXPIRE INTERVAL n DAY           both ok
 *   WITH MAX_USER_CONNECTIONS n              both ok
 *
 * And one ordering trap, which both servers reject identically:
 *
 *   ALTER USER u ACCOUNT LOCK WITH MAX_USER_CONNECTIONS 5    ERROR 1064
 *   ALTER USER u WITH MAX_USER_CONNECTIONS 5 ACCOUNT LOCK    ok
 *
 * The resource clause has to precede the lock and password options. Rather
 * than depend on getting that order right, each change is its own statement:
 * they can then be reported individually when one fails, which matters because
 * ALTER USER commits as it runs and a half-applied edit is a real state.
 */

/** What to do about the account lock. Absent means leave it alone. */
export type LockAction = "lock" | "unlock";

/**
 * What to do about password expiry.
 *
 * "now" forces a change at next login; "never" exempts the account; "default"
 * hands it back to `default_password_lifetime`; a number sets an interval in
 * days.
 */
export type PasswordExpiry = "now" | "never" | "default" | { days: number };

export interface AlterUserOptions {
  username: string;
  host: string;
  /** Absent means leave the lock alone. */
  lock?: LockAction;
  /** Absent means leave expiry alone. */
  expiry?: PasswordExpiry;
  /** Absent means leave it alone. 0 means unlimited, which is MySQL's own encoding. */
  maxConnections?: number;
  /** A new host. Absent, or the same host, means no rename. */
  newHost?: string;
}

/** `'user'@'host'`, quoted. */
function userSpec(username: string, host: string): string {
  return `${quoteStringLiteral(username)}@${quoteStringLiteral(host)}`;
}

function expiryClause(expiry: PasswordExpiry): string {
  if (expiry === "now") return "PASSWORD EXPIRE";
  if (expiry === "never") return "PASSWORD EXPIRE NEVER";
  if (expiry === "default") return "PASSWORD EXPIRE DEFAULT";
  return `PASSWORD EXPIRE INTERVAL ${Math.max(1, Math.floor(expiry.days))} DAY`;
}

/**
 * The statements for this edit, in the order they must run.
 *
 * Only what the caller asked for. Nothing restates a value it was not given —
 * on MariaDB the panel cannot read lock or expiry state at all (#440), so a
 * statement that "restored" them would be guessing, and guessing wrong here
 * unlocks an account somebody locked on purpose.
 *
 * A rename comes last: the earlier statements address the user by its old
 * host, and renaming first would leave them pointing at a user that no longer
 * exists under that name.
 */
export function buildAlterUserStatements(options: AlterUserOptions): string[] {
  const { username, host, lock, expiry, maxConnections, newHost } = options;
  const spec = userSpec(username, host);
  const statements: string[] = [];

  if (maxConnections !== undefined) {
    statements.push(
      `ALTER USER ${spec} WITH MAX_USER_CONNECTIONS ${Math.max(0, Math.floor(maxConnections))}`,
    );
  }
  if (lock) {
    statements.push(`ALTER USER ${spec} ACCOUNT ${lock === "lock" ? "LOCK" : "UNLOCK"}`);
  }
  if (expiry !== undefined) {
    statements.push(`ALTER USER ${spec} ${expiryClause(expiry)}`);
  }
  if (newHost !== undefined && newHost !== host) {
    // RENAME rather than ALTER: a user's host is half its identity, and MySQL
    // has no ALTER that moves one.
    statements.push(`RENAME USER ${spec} TO ${userSpec(username, newHost)}`);
  }

  return statements;
}
