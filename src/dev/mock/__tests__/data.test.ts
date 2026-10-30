import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRoleGrantsQuery, listRolesQuery } from "../../../lib/admin/roles";
import type {
  ConnectionInfo,
  EventInfo,
  ForeignKeyInfo,
  HistoryEntry,
  QueryResult_Serialize,
  SqliteTableInfo,
} from "../../../lib/bindings";
import { call, install, rejection, settle } from "./helpers";

let conn: ConnectionInfo;

const run = async (sql: string, connectionId = conn.id) =>
  settle(call<QueryResult_Serialize[]>("execute_query", { connectionId, sql })).then((r) => r[0]);

const USERS_SQL =
  "SELECT User, Host, account_locked, password_expired, password_last_changed FROM mysql.user ORDER BY User, Host";

describe("fixture data", () => {
  beforeEach(async () => {
    install("?mock=servers");
    vi.useFakeTimers();
    conn = await settle(call<ConnectionInfo>("connect", { profileId: "profile-local" }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("has more than a page of history", async () => {
    expect(await call<number>("history_count")).toBeGreaterThanOrEqual(100);
    const page2 = await settle(
      call<HistoryEntry[]>("history_list", { query: { limit: 50, offset: 50, sort: "recent" } }),
    );
    expect(page2).toHaveLength(50);
    // Newest first across the pages, ids unique.
    const all = await settle(call<HistoryEntry[]>("history_list", { query: { sort: "recent" } }));
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect([...all].sort((a, b) => b.executedAt.localeCompare(a.executedAt))).toEqual(all);
  });

  it("has events in shop, in each state", async () => {
    const events = await settle(call<EventInfo[]>("get_events", { connectionId: conn.id, database: "shop" }));
    expect(events.map((e) => [e.event_type, e.status])).toEqual(expect.arrayContaining([
      ["RECURRING", "ENABLED"],
      ["RECURRING", "DISABLED"],
      ["ONE TIME", "ENABLED"],
    ]));
    for (const e of events) {
      const ddl = await run(`SHOW CREATE EVENT \`shop\`.\`${e.name}\``);
      expect(String(ddl.rows[0][3])).toContain(`EVENT \`${e.name}\``);
    }
  });

  it("has a view in the SQLite fixture", async () => {
    const id = await settle(call<string>("sqlite_open", { path: "/tmp/sqlpilot-mock/inventory.sqlite" }));
    const tables = await call<SqliteTableInfo[]>("sqlite_get_tables", { connectionId: id });
    expect(tables.some((t) => t.table_type === "view")).toBe(true);
  });

  it("has a foreign key in the SQLite fixture (#924)", async () => {
    const id = await settle(call<string>("sqlite_open", { path: "/tmp/sqlpilot-mock/inventory.sqlite" }));
    const keys = await call<ForeignKeyInfo[]>("sqlite_get_foreign_keys", { connectionId: id, table: "note_tags" });
    expect(keys).toEqual([expect.objectContaining({
      columns: ["note_id"],
      referenced_table: "notes",
      referenced_columns: ["id"],
      on_delete: "CASCADE",
    })]);
    expect(await call("sqlite_get_foreign_keys", { connectionId: id, table: "notes" })).toEqual([]);
  });

  describe("server accounts", () => {
    it("lists users with their status columns on MySQL", async () => {
      const r = await run(USERS_SQL);
      expect(r.columns.map((c) => c.name)).toEqual([
        "User",
        "Host",
        "account_locked",
        "password_expired",
        "password_last_changed",
      ]);
      expect(r.rows.length).toBeGreaterThan(5);
      expect(r.rows).toContainEqual(["legacy_etl", "%", "Y", "N", "2025-01-30 04:00:00"]);
    });

    it("lists roles and who holds them", async () => {
      const roles = await run(listRolesQuery("mysql"));
      expect(roles.rows).toEqual([["app_read", "%"]]);
      const held = await run(listRoleGrantsQuery("mysql"));
      expect(held.rows).toContainEqual(["app_read", "readonly", "%"]);
    });

    it("shows grants in the server's format", async () => {
      const r = await run("SHOW GRANTS FOR 'app'@'10.0.3.%'");
      expect(r.columns[0].name).toBe("Grants for app@10.0.3.%");
      expect(r.rows.map((row) => row[0])).toEqual([
        "GRANT USAGE ON *.* TO `app`@`10.0.3.%`",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON `shop`.* TO `app`@`10.0.3.%`",
      ]);
      expect(await rejection("execute_query", { connectionId: conn.id, sql: "SHOW GRANTS FOR 'nobody'@'%'" }))
        .toMatchObject({ code: 1141 });
    });

    it("creates, alters, grants to and drops a user", async () => {
      await run("CREATE USER 'newbie'@'%' IDENTIFIED BY 'x' PASSWORD EXPIRE");
      expect((await run(USERS_SQL)).rows).toContainEqual(["newbie", "%", "N", "Y", "2026-10-18 12:00:00"]);
      expect(await rejection("execute_query", { connectionId: conn.id, sql: "CREATE USER 'newbie'@'%'" }))
        .toMatchObject({ code: 1396, message: "Operation CREATE USER failed for 'newbie'@'%'" });

      await run("ALTER USER 'newbie'@'%' ACCOUNT LOCK");
      await run("GRANT SELECT, INSERT ON `shop`.* TO 'newbie'@'%'");
      expect((await run("SHOW GRANTS FOR 'newbie'@'%'")).rows.map((r) => r[0])).toContain(
        "GRANT SELECT, INSERT ON `shop`.* TO `newbie`@`%`",
      );
      await run("REVOKE INSERT ON `shop`.* FROM 'newbie'@'%'");
      expect((await run("SHOW GRANTS FOR 'newbie'@'%'")).rows.map((r) => r[0])).toContain(
        "GRANT SELECT ON `shop`.* TO `newbie`@`%`",
      );
      expect((await run(USERS_SQL)).rows).toContainEqual(["newbie", "%", "Y", "Y", "2026-10-18 12:00:00"]);

      await run("DROP USER 'newbie'@'%'");
      expect((await run(USERS_SQL)).rows.map((r) => r[0])).not.toContain("newbie");
    });

    it("fails the full user query on MariaDB, as the real server does", async () => {
      const maria = await settle(call<ConnectionInfo>("connect", { profileId: "profile-mariadb" }));
      expect(await rejection("execute_query", { connectionId: maria.id, sql: USERS_SQL })).toMatchObject({
        code: 1054,
      });
      const fallback = await run("SELECT DISTINCT User, Host FROM mysql.user ORDER BY User, Host", maria.id);
      expect(fallback.rows.length).toBeGreaterThan(5);
      expect((await run(listRolesQuery("mariadb"), maria.id)).rows).toEqual([["app_read", ""]]);
    });
  });
});
