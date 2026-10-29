import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile_Deserialize, TestConnectionResult } from "../../../lib/bindings";
import { call, install, rejection, settle } from "./helpers";

const profile = (port: number, sshPort?: number): ConnectionProfile_Deserialize => ({
  id: "",
  name: "New",
  group: null,
  color: null,
  host: "db.example.internal",
  port,
  username: "app",
  password: "",
  default_database: null,
  ssh_config: sshPort === undefined
    ? null
    : { host: "bastion.example.internal", port: sshPort, username: "app", private_key_path: null },
  ssl_config: null,
  read_only: false,
  connect_timeout_secs: null,
  query_timeout_secs: null,
  charset: null,
  environment: null,
});

describe("port validation", () => {
  beforeEach(() => {
    install("?mock");
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["save_connection_profile", "test_connection"])("%s refuses a port that is not a u16", async (cmd) => {
    expect(await rejection(cmd, { profile: profile(70_000) })).toBe(
      `invalid args \`profile\` for command \`${cmd}\`: invalid value: integer \`70000\`, expected u16`,
    );
    expect(await rejection(cmd, { profile: profile(-1) })).toMatch(/invalid value: integer `-1`, expected u16$/);
    expect(await rejection(cmd, { profile: profile(3306.5) })).toMatch(
      /invalid type: floating point `3306.5`, expected u16$/,
    );
    expect(await rejection(cmd, { profile: profile(3306, 65_536) })).toMatch(/integer `65536`, expected u16$/);
  });

  it("saves the ends of the range", async () => {
    for (const port of [1, 65_535]) {
      expect(typeof await settle(call("save_connection_profile", { profile: profile(port) }))).toBe("string");
    }
  });

  it("lets port 0 through, as the backend does, and fails to connect to it", async () => {
    expect(typeof await settle(call("save_connection_profile", { profile: profile(0) }))).toBe("string");
    const test = await settle(call<TestConnectionResult>("test_connection", { profile: profile(0) }));
    expect(test.success).toBe(false);
    expect(test.message).toContain("Nothing is listening on db.example.internal:0");
  });
});
