// Server accounts: `mysql.user`, the role tables, SHOW GRANTS and the user
// statements, so the admin panel's Users and Roles tabs have people in them.
//
// Not a handler file of its own: the Users tab reads through `execute_query`,
// so query.ts hands these statements here first. Accounts are kept in memory
// and changed by CREATE USER, DROP USER, ALTER USER, RENAME USER, CREATE ROLE,
// GRANT and REVOKE, so creating a user and refreshing shows them.
//
// The columns differ by server as they do for real. MySQL 8's mysql.user has
// account_locked, password_expired and password_last_changed, and marks a
// role only by being locked, expired and passwordless; MariaDB's has is_role
// and none of the first three, so the full query the Users tab tries first
// fails there with 1054 and the tab falls back, as it does on a real MariaDB.

import type { SqlValue } from "../../../lib/bindings";

export interface Account {
  user: string;
  host: string;
  locked: boolean;
  expired: boolean;
  /** `YYYY-MM-DD hh:mm:ss`, as the column reads. */
  passwordChanged: string;
  /** Empty for a role. */
  authString: string;
  plugin: string;
  isRole: boolean;
  /** Everything but the USAGE line SHOW GRANTS always starts with. */
  grants: { privileges: string; on: string; grantOption?: boolean }[];
}

const HASH = "$A$005$mock-hash-not-a-real-credential";

const account = (user: string, host: string, extra: Partial<Account> = {}): Account => ({
  user,
  host,
  locked: false,
  expired: false,
  passwordChanged: "2026-07-02 09:14:00",
  authString: HASH,
  plugin: "caching_sha2_password",
  isRole: false,
  grants: [],
  ...extra,
});

function seedAccounts(): Account[] {
  return [
    account("analyst", "10.0.5.%", {
      expired: true,
      passwordChanged: "2026-03-11 16:20:41",
      grants: [{ privileges: "SELECT", on: "`analytics`.*" }],
    }),
    account("app", "10.0.3.%", {
      passwordChanged: "2026-08-19 10:02:13",
      grants: [{ privileges: "SELECT, INSERT, UPDATE, DELETE", on: "`shop`.*" }],
    }),
    // A role, as MySQL makes one: locked, expired, no password.
    account("app_read", "%", {
      locked: true,
      expired: true,
      authString: "",
      isRole: true,
      grants: [{ privileges: "SELECT", on: "`shop`.*" }],
    }),
    account("legacy_etl", "%", {
      locked: true,
      passwordChanged: "2025-01-30 04:00:00",
      plugin: "mysql_native_password",
      grants: [{ privileges: "SELECT, INSERT", on: "`analytics`.*" }],
    }),
    account("migrator", "10.0.3.40", {
      grants: [{ privileges: "ALL PRIVILEGES", on: "`shop`.*" }],
    }),
    account("mysql.infoschema", "localhost", { locked: true, grants: [{ privileges: "SELECT", on: "*.*" }] }),
    account("mysql.session", "localhost", { locked: true, grants: [{ privileges: "SHUTDOWN, SUPER", on: "*.*" }] }),
    account("mysql.sys", "localhost", { locked: true }),
    account("readonly", "%", {
      grants: [{ privileges: "SELECT", on: "`shop`.*" }, { privileges: "SELECT", on: "`analytics`.*" }],
    }),
    account("repl", "10.0.4.%", { grants: [{ privileges: "REPLICATION SLAVE", on: "*.*" }] }),
    account("root", "localhost", { grants: [{ privileges: "ALL PRIVILEGES", on: "*.*", grantOption: true }] }),
  ];
}

/** Which role is granted to whom: [role, user, host]. */
type Edge = [role: string, user: string, host: string];
const seedEdges = (): Edge[] => [
  ["app_read", "analyst", "10.0.5.%"],
  ["app_read", "readonly", "%"],
];

let accounts = seedAccounts();
let edges = seedEdges();

/** Back to the fixture, for a fresh page or test. */
export function resetAccounts(): void {
  accounts = seedAccounts();
  edges = seedEdges();
}

// ---------------------------------------------------------------- parsing

/** What a statement on accounts produced, or the server error it hit. */
export type AccountAnswer =
  | { kind: "rows"; columns: string[]; rows: SqlValue[][] }
  | { kind: "done" }
  | { kind: "error"; code: number; sqlState: string; message: string };

const err = (code: number, sqlState: string, message: string): AccountAnswer => ({
  kind: "error",
  code,
  sqlState,
  message,
});

/** `'app'@'10.0.3.%'`, `` `app`@`%` ``, `"app"@localhost`, or a bare `app`. */
const PART = String.raw`(?:'(?:[^']|'')*'|\x60[^\x60]*\x60|"[^"]*"|[\w.%$-]+)`;
const ACCOUNT = new RegExp(`(${PART})(?:\\s*@\\s*(${PART}))?`, "g");

function unquotePart(raw: string): string {
  const q = raw[0];
  if (q === "'" || q === "`" || q === "\"") return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

/** Every account named in a list such as `'a'@'%', 'b'@'localhost'`. */
function accountsIn(text: string): { user: string; host: string }[] {
  return [...text.matchAll(ACCOUNT)].map((m) => ({
    user: unquotePart(m[1]),
    host: m[2] ? unquotePart(m[2]) : "%",
  }));
}

const find = (user: string, host: string) => accounts.find((a) => a.user === user && a.host === host);
const named = (user: string, host: string) => `'${user}'@'${host}'`;
const backticked = (user: string, host: string) => `\`${user}\`@\`${host}\``;

// ---------------------------------------------------------------- reads

type Columns = Record<string, (a: Account) => SqlValue>;

const yn = (b: boolean) => (b ? "Y" : "N");

const MYSQL_USER: Columns = {
  host: (a) => a.host,
  user: (a) => a.user,
  account_locked: (a) => yn(a.locked),
  password_expired: (a) => yn(a.expired),
  password_last_changed: (a) => a.passwordChanged,
  authentication_string: (a) => a.authString,
  plugin: (a) => a.plugin,
  max_user_connections: () => "0",
};

const MARIADB_USER: Columns = {
  host: (a) => a.host,
  user: (a) => a.user,
  password_expired: (a) => yn(a.expired),
  authentication_string: (a) => a.authString,
  plugin: (a) => (a.plugin === "caching_sha2_password" ? "mysql_native_password" : a.plugin),
  is_role: (a) => yn(a.isRole),
  max_user_connections: () => "0",
};

interface Item {
  label: string;
  value: (row: Record<string, SqlValue>) => SqlValue;
}

/** The select list over the table's columns, or the 1054 for one it lacks. */
function selectList(text: string, columns: string[]): Item[] | AccountAnswer {
  const items: Item[] = [];
  for (const raw of text.replace(/^distinct\s+/i, "").split(",").map((s) => s.trim())) {
    if (raw === "*") {
      for (const c of columns) items.push({ label: c, value: (r) => r[c] });
      continue;
    }
    const m = /^(.+?)(?:\s+as\s+`?(\w+)`?)?$/i.exec(raw);
    const expr = (m?.[1] ?? raw).trim();
    const label = m?.[2] ?? expr.replace(/`/g, "");
    const literal = /^'((?:[^']|'')*)'$/.exec(expr);
    if (literal) {
      items.push({ label, value: () => literal[1] });
      continue;
    }
    const name = expr.replace(/`/g, "").toLowerCase();
    if (!columns.includes(name)) return err(1054, "42S22", `Unknown column '${expr}' in 'field list'`);
    items.push({ label, value: (r) => r[name] });
  }
  return items;
}

/** `a = 'x' AND b <> 'y'`: all the WHERE the admin panel writes. */
function whereFilter(
  text: string | undefined,
  columns: string[],
): ((r: Record<string, SqlValue>) => boolean) | AccountAnswer {
  if (!text) return () => true;
  const tests: ((r: Record<string, SqlValue>) => boolean)[] = [];
  for (const part of text.split(/\s+and\s+/i)) {
    const m = /^`?(\w+)`?\s*(=|<>|!=)\s*'((?:[^']|'')*)'$/.exec(part.trim());
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (!columns.includes(name)) return err(1054, "42S22", `Unknown column '${m[1]}' in 'where clause'`);
    const want = m[3].replace(/''/g, "'");
    tests.push(m[2] === "=" ? (r) => r[name] === want : (r) => r[name] !== want);
  }
  return (r) => tests.every((t) => t(r));
}

function selectFrom(table: string, clean: string, mariadb: boolean): AccountAnswer {
  const rows: Record<string, SqlValue>[] = [];
  let columns: string[];
  if (table === "user") {
    const cols = mariadb ? MARIADB_USER : MYSQL_USER;
    columns = Object.keys(cols);
    for (const a of accounts) rows.push(Object.fromEntries(columns.map((c) => [c, cols[c](a)])));
  } else if (table === "role_edges" && !mariadb) {
    columns = ["from_host", "from_user", "to_host", "to_user", "with_admin_option"];
    for (const [role, user, host] of edges) {
      rows.push({ from_host: "%", from_user: role, to_host: host, to_user: user, with_admin_option: "N" });
    }
  } else if (table === "roles_mapping" && mariadb) {
    columns = ["host", "user", "role", "admin_option"];
    for (const [role, user, host] of edges) rows.push({ host, user, role, admin_option: "N" });
  } else {
    return err(1146, "42S02", `Table 'mysql.${table}' doesn't exist`);
  }

  const list = /^select\s+([\s\S]+?)\s+from\s/i.exec(clean)?.[1] ?? "*";
  const items = selectList(list, columns);
  if (!Array.isArray(items)) return items;
  const where = /\bwhere\s+([\s\S]+?)(?:\s+order\s+by\b|\s+limit\b|$)/i.exec(clean)?.[1];
  const keep = whereFilter(where, columns);
  if (typeof keep !== "function") return keep;
  // ORDER BY User, Host is what every read here asks for, and the fixture is
  // kept in that order.
  return {
    kind: "rows",
    columns: items.map((i) => i.label),
    rows: rows.filter(keep).map((r) => items.map((i) => i.value(r))),
  };
}

function showGrants(clean: string): AccountAnswer {
  const target = /^show\s+grants\s+for\s+(.+)$/i.exec(clean)?.[1];
  const [who] = target ? accountsIn(target) : [];
  // SHOW GRANTS with no FOR: the session's own account.
  const a = who ? find(who.user, who.host) : find("root", "localhost");
  if (!a) {
    const asked = who ?? { user: "root", host: "localhost" };
    return err(1141, "42000", `There is no such grant defined for user '${asked.user}' on host '${asked.host}'`);
  }
  const to = backticked(a.user, a.host);
  const lines = [
    ...(a.grants.some((g) => g.on === "*.*") ? [] : [`GRANT USAGE ON *.* TO ${to}`]),
    ...a.grants.map((g) => `GRANT ${g.privileges} ON ${g.on} TO ${to}${g.grantOption ? " WITH GRANT OPTION" : ""}`),
    ...edges.filter(([, u, h]) => u === a.user && h === a.host).map(([role]) => `GRANT \`${role}\`@\`%\` TO ${to}`),
  ];
  return { kind: "rows", columns: [`Grants for ${a.user}@${a.host}`], rows: lines.map((l) => [l]) };
}

// ---------------------------------------------------------------- writes

function createUser(clean: string, role: boolean): AccountAnswer {
  const rest = clean.replace(/^create\s+(user|role)\s+(if\s+not\s+exists\s+)?/i, "");
  const ifNotExists = /^create\s+(user|role)\s+if\s+not\s+exists\b/i.test(clean);
  // The account list ends where the options start.
  const list = rest.split(/\s+(?=identified\b|default\b|require\b|with\b|password\b|account\b|comment\b)/i)[0];
  const created = accountsIn(list);
  const clash = created.find((c) => find(c.user, c.host));
  if (clash && !ifNotExists) {
    return err(1396, "HY000", `Operation CREATE ${role ? "ROLE" : "USER"} failed for ${named(clash.user, clash.host)}`);
  }
  for (const c of created) {
    if (find(c.user, c.host)) continue;
    accounts.push(
      account(c.user, c.host, {
        locked: role || /\baccount\s+lock\b/i.test(clean),
        expired: role || /\bpassword\s+expire\b(?!\s+(never|default|interval))/i.test(clean),
        authString: role ? "" : HASH,
        isRole: role,
        passwordChanged: "2026-10-18 12:00:00",
      }),
    );
  }
  accounts.sort((a, b) => a.user.localeCompare(b.user) || a.host.localeCompare(b.host));
  return { kind: "done" };
}

function dropUser(clean: string): AccountAnswer {
  const ifExists = /^drop\s+(user|role)\s+if\s+exists\b/i.test(clean);
  const gone = accountsIn(clean.replace(/^drop\s+(user|role)\s+(if\s+exists\s+)?/i, ""));
  const missing = gone.find((g) => !find(g.user, g.host));
  if (missing && !ifExists) {
    const kind = /^drop\s+role/i.test(clean) ? "ROLE" : "USER";
    return err(1396, "HY000", `Operation DROP ${kind} failed for ${named(missing.user, missing.host)}`);
  }
  accounts = accounts.filter((a) => !gone.some((g) => g.user === a.user && g.host === a.host));
  edges = edges.filter(([r, u, h]) => !gone.some((g) => (g.user === u && g.host === h) || g.user === r));
  return { kind: "done" };
}

function alterUser(clean: string): AccountAnswer {
  const rest = clean.replace(/^alter\s+user\s+(if\s+exists\s+)?/i, "");
  const [who] = accountsIn(rest);
  const a = who && find(who.user, who.host);
  if (!a) return err(1396, "HY000", `Operation ALTER USER failed for ${named(who?.user ?? "", who?.host ?? "%")}`);
  if (/\bidentified\b/i.test(clean)) {
    a.passwordChanged = "2026-10-18 12:00:00";
    a.expired = false;
  }
  if (/\bpassword\s+expire\s*(;|$)/i.test(clean)) a.expired = true;
  if (/\baccount\s+lock\b/i.test(clean)) a.locked = true;
  if (/\baccount\s+unlock\b/i.test(clean)) a.locked = false;
  return { kind: "done" };
}

function renameUser(clean: string): AccountAnswer {
  const pairs = clean.replace(/^rename\s+user\s+/i, "").split(/\s*,\s*(?=(?:'|`|"|\w))/);
  for (const pair of pairs) {
    const [from, to] = pair.split(/\s+to\s+/i).map((s) => accountsIn(s)[0]);
    const a = from && find(from.user, from.host);
    if (!a || !to) {
      return err(1396, "HY000", `Operation RENAME USER failed for ${named(from?.user ?? "", from?.host ?? "%")}`);
    }
    if (find(to.user, to.host)) {
      return err(1396, "HY000", `Operation RENAME USER failed for ${named(from.user, from.host)}`);
    }
    a.user = to.user;
    a.host = to.host;
  }
  return { kind: "done" };
}

function grant(clean: string): AccountAnswer {
  // GRANT role TO user: no ON clause.
  const roleGrant = /^grant\s+(.+?)\s+to\s+(.+?)(?:\s+with\s+admin\s+option)?$/i.exec(clean);
  if (roleGrant && !/\son\s/i.test(roleGrant[1])) {
    for (const r of accountsIn(roleGrant[1])) {
      for (const u of accountsIn(roleGrant[2])) {
        if (!find(u.user, u.host)) return err(1396, "HY000", `Operation GRANT failed for ${named(u.user, u.host)}`);
        if (!edges.some(([er, eu, eh]) => er === r.user && eu === u.user && eh === u.host)) {
          edges.push([r.user, u.user, u.host]);
        }
      }
    }
    return { kind: "done" };
  }
  const m = /^grant\s+(.+?)\s+on\s+(.+?)\s+to\s+(.+?)(\s+with\s+grant\s+option)?$/i.exec(clean);
  if (!m) return { kind: "done" };
  for (const u of accountsIn(m[3])) {
    const a = find(u.user, u.host);
    if (!a) return err(1410, "42000", "You are not allowed to create a user with GRANT");
    a.grants.push({ privileges: m[1].toUpperCase(), on: m[2], grantOption: Boolean(m[4]) });
  }
  return { kind: "done" };
}

function revoke(clean: string): AccountAnswer {
  const m = /^revoke\s+(.+?)\s+on\s+(.+?)\s+from\s+(.+)$/i.exec(clean);
  if (!m) {
    const roleRevoke = /^revoke\s+(.+?)\s+from\s+(.+)$/i.exec(clean);
    if (roleRevoke) {
      const roles = accountsIn(roleRevoke[1]).map((r) => r.user);
      const users = accountsIn(roleRevoke[2]);
      edges = edges.filter(([r, u, h]) => !(roles.includes(r) && users.some((x) => x.user === u && x.host === h)));
    }
    return { kind: "done" };
  }
  const scope = m[2].replace(/`/g, "");
  const removed = m[1].split(",").map((p) => p.trim().toUpperCase());
  for (const u of accountsIn(m[3])) {
    const a = find(u.user, u.host);
    if (!a) continue;
    a.grants = a.grants
      .map((g) => {
        if (g.on.replace(/`/g, "") !== scope) return g;
        if (removed.includes("ALL") || removed.includes("ALL PRIVILEGES")) return null;
        const left = g.privileges.split(",").map((p) => p.trim()).filter((p) => !removed.includes(p.toUpperCase()));
        return left.length ? { ...g, privileges: left.join(", ") } : null;
      })
      .filter((g): g is Account["grants"][number] => g !== null);
  }
  return { kind: "done" };
}

/**
 * A statement on accounts, answered; undefined for any other statement.
 *
 * `clean` is the statement with comments stripped and whitespace collapsed.
 */
export function accountStatement(clean: string, mariadb: boolean): AccountAnswer | undefined {
  const from = /^select\b[\s\S]*?\bfrom\s+`?mysql`?\s*\.\s*`?(user|role_edges|roles_mapping|global_priv)`?\b/i.exec(
    clean,
  );
  if (from) return selectFrom(from[1].toLowerCase(), clean, mariadb);
  if (/^show\s+grants\b/i.test(clean)) return showGrants(clean);
  if (/^create\s+user\b/i.test(clean)) return createUser(clean, false);
  if (/^create\s+role\b/i.test(clean)) return createUser(clean, true);
  if (/^drop\s+(user|role)\b/i.test(clean)) return dropUser(clean);
  if (/^alter\s+user\b/i.test(clean)) return alterUser(clean);
  if (/^rename\s+user\b/i.test(clean)) return renameUser(clean);
  if (/^grant\b/i.test(clean)) return grant(clean);
  if (/^revoke\b/i.test(clean)) return revoke(clean);
  return undefined;
}
