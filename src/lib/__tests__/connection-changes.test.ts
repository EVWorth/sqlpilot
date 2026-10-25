import { describe, expect, it } from "vitest";
import type { ConnectionProfile, ConnectionProfileInput } from "../../types";
import { connectionSettingsChanged } from "../connection-changes";

const before: ConnectionProfile = {
  id: "p1",
  name: "Local dev",
  group: null,
  color: "#22c55e",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  default_database: "shop",
  ssh_config: null,
  ssl_config: null,
  pool_min: 1,
  pool_max: 5,
  read_only: false,
  connect_timeout_secs: 10,
  query_timeout_secs: 0,
  charset: "utf8mb4",
  environment: "development",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

/** The form as it opens on `before`: the same values, blank credentials. */
const edit = (changes: Partial<ConnectionProfileInput>): ConnectionProfileInput => ({
  ...before,
  password: "",
  ...changes,
});

describe("connectionSettingsChanged (#831)", () => {
  it("is false for an untouched form", () => {
    expect(connectionSettingsChanged(before, edit({}))).toBe(false);
  });

  it("ignores what is only shown: name, colour, group, environment", () => {
    expect(
      connectionSettingsChanged(
        before,
        edit({ name: "Renamed", color: "#ff0000", group: "x", environment: "production" }),
      ),
    ).toBe(false);
  });

  it.each(
    [
      ["host", { host: "10.9.9.9" }],
      ["port", { port: 3307 }],
      ["user", { username: "app" }],
      ["password", { password: "new" }],
      ["default database", { default_database: "other" }],
      ["read-only", { read_only: true }],
      ["SSL", { ssl_config: { mode: "Required", ca_cert_path: null, client_cert_path: null, client_key_path: null } }],
      ["SSH", { ssh_config: { host: "bastion", port: 22, username: "me", private_key_path: null } }],
    ] as const,
  )("is true when the %s changes", (_label, changes) => {
    expect(connectionSettingsChanged(before, edit(changes as Partial<ConnectionProfileInput>))).toBe(true);
  });

  it("treats an empty and a missing default database as the same", () => {
    expect(connectionSettingsChanged({ ...before, default_database: null }, edit({ default_database: "" }))).toBe(
      false,
    );
  });
});
