import { listen } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectionHealth,
  ConnectionInfo,
  ConnectionProfileSummary_Serialize,
  TestConnectionResult,
} from "../../../lib/bindings";
import { LOST_AFTER_MS, RETRY_EVERY_MS } from "../handlers/connections";
import { scenarioFromUrl } from "../state";
import { call, install, rejection, settle } from "./helpers";

const profileOf = async (id: string) => {
  const list = await settle(call<ConnectionProfileSummary_Serialize[]>("list_connection_profiles"));
  const found = list.find((p) => p.id === id);
  if (!found) throw new Error(`no profile ${id}`);
  return { ...found, password: "" };
};

describe("connection scenarios", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads the new scenarios from the URL", () => {
    expect(scenarioFromUrl("?mock=lost")).toBe("lost");
    expect(scenarioFromUrl("?mock=servers")).toBe("servers");
    expect(scenarioFromUrl("?mock=nonsense")).toBe("default");
  });

  it("keeps the default profile list as it was", async () => {
    install("?mock");
    const list = await call<ConnectionProfileSummary_Serialize[]>("list_connection_profiles");
    expect(list.map((p) => p.id)).toEqual(["profile-local", "profile-staging", "profile-prod", "profile-maria"]);
  });

  describe("?mock=servers", () => {
    it("adds a profile per connect outcome", async () => {
      install("?mock=servers");
      const list = await call<ConnectionProfileSummary_Serialize[]>("list_connection_profiles");
      expect(list.map((p) => p.id)).toEqual(expect.arrayContaining([
        "profile-prod-rw",
        "profile-mariadb",
        "profile-bad-password",
        "profile-timeout",
      ]));
    });

    it("rejects the wrong password with the server's 1045", async () => {
      install("?mock=servers");
      vi.useFakeTimers();
      const error = await settle(rejection("connect", { profileId: "profile-bad-password" }));
      expect(error).toMatch(/^Connection error: Could not connect "Wrong password"\. The server is reachable/);
      expect(error).toContain("1045 (28000): Access denied for user 'app'");

      const test = await settle(
        call<TestConnectionResult>("test_connection", { profile: await profileOf("profile-bad-password") }),
      );
      expect(test.success).toBe(false);
      expect(test.message).toMatch(/^Connection failed\. The server is reachable and rejected the credentials/);
    });

    it("times out on a server that never answers, after two connect timeouts", async () => {
      install("?mock=servers");
      vi.useFakeTimers();
      let settled = false;
      const pending = rejection("connect", { profileId: "profile-timeout" }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(settled).toBe(false);
      const error = await settle(pending);
      expect(error).toContain("10.20.30.40:3306 did not answer within 2s");
    });

    it("connects to a MariaDB server", async () => {
      install("?mock=servers");
      vi.useFakeTimers();
      const conn = await settle(call<ConnectionInfo>("connect", { profileId: "profile-mariadb" }));
      expect(conn.server_version).toMatch(/MariaDB/);
      const test = await settle(
        call<TestConnectionResult>("test_connection", { profile: await profileOf("profile-mariadb") }),
      );
      expect(test).toMatchObject({ success: true, message: "Connected to MariaDB 11.4.3" });
    });

    it("has a production server that takes writes", async () => {
      install("?mock=servers");
      vi.useFakeTimers();
      const conn = await settle(call<ConnectionInfo>("connect", { profileId: "profile-prod-rw" }));
      expect(conn.environment).toBe("production");
      const sql = "UPDATE orders SET status = 'paid' WHERE id = 3";
      const results = await settle(call<unknown[]>("execute_query", { connectionId: conn.id, sql }));
      expect(results).toHaveLength(1);
      const agents = await settle(call<{ connectionId: string; readOnly: boolean }[]>("list_agent_connections"));
      expect(agents.find((a) => a.connectionId === "profile-prod-rw")).toMatchObject({ readOnly: false });
    });
  });

  describe("?mock=lost", () => {
    it("fails every health check from a few seconds in, and counts them", async () => {
      install("?mock=lost");
      vi.useFakeTimers();
      const reports: ConnectionHealth[] = [];
      await listen<ConnectionHealth>("connection-health-event", (e) => reports.push(e.payload));
      const conn = await call<ConnectionInfo>("connect", { profileId: "profile-local" });

      expect(await call<ConnectionHealth>("connection_health", { connectionId: conn.id })).toMatchObject({
        healthy: true,
      });
      await vi.advanceTimersByTimeAsync(LOST_AFTER_MS + 2 * RETRY_EVERY_MS);
      expect(reports.map((r) => [r.healthy, r.consecutiveFailures])).toEqual([[false, 1], [false, 2], [false, 3]]);
      expect(await call<ConnectionHealth>("connection_health", { connectionId: conn.id })).toMatchObject({
        healthy: false,
        consecutiveFailures: 3,
      });
    });

    it("fails reads on the lost server and still disconnects", async () => {
      install("?mock=lost");
      vi.useFakeTimers();
      const conn = await call<ConnectionInfo>("connect", { profileId: "profile-local" });
      await vi.advanceTimersByTimeAsync(LOST_AFTER_MS);

      expect(await rejection("execute_query", { connectionId: conn.id, sql: "SELECT 1" })).toMatchObject({
        code: 2013,
        sqlState: "HY000",
      });
      expect(await rejection("get_tables", { connectionId: conn.id, database: "shop" })).toMatch(/2013 \(HY000\)/);
      const ping = await settle(call<ConnectionHealth>("ping_connection", { connectionId: conn.id }));
      expect(ping).toMatchObject({ healthy: false, consecutiveFailures: 2 });

      await settle(call("disconnect", { connectionId: conn.id }));
      const left = await call<ConnectionInfo[]>("list_connections");
      expect(left.map((c) => c.id)).not.toContain(conn.id);
    });
  });
});
