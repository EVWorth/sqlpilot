import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveProfileFn, apiMocks } = vi.hoisted(() => ({
  saveProfileFn: vi.fn(),
  apiMocks: { testConnection: vi.fn() },
}));

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) => selector({ saveProfile: saveProfileFn }),
}));

vi.mock("../../../lib/tauri-api", () => ({ api: apiMocks }));

import { useConnectionForm } from "../useConnectionForm";

/** A saved profile, as the backend sends one back: no credentials. */
const saved = {
  id: "p1",
  name: "Prod",
  host: "db.example.com",
  port: 3306,
  username: "root",
  password: "",
  default_database: "shop",
  pool_min: 1,
  pool_max: 5,
  read_only: false,
  connect_timeout_secs: 10,
  query_timeout_secs: 0,
  charset: "utf8mb4",
  group: null,
  color: null,
  environment: null,
  ssh_config: null,
  ssl_config: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as never;

describe("useConnectionForm (#275)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveProfileFn.mockResolvedValue(undefined);
    apiMocks.testConnection.mockResolvedValue({
      success: true,
      message: "Connected",
      server_version: "8.0.36",
      latency_ms: 4,
    });
  });

  it("starts a new profile with the sensible defaults", () => {
    const { result } = renderHook(() => useConnectionForm(true));
    expect(result.current.form.host).toBe("127.0.0.1");
    expect(result.current.form.port).toBe(3306);
    expect(result.current.form.pool_max).toBe(5);
    expect(result.current.form.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("cannot save until it has a name and a host", () => {
    const { result } = renderHook(() => useConnectionForm(true));
    expect(result.current.canSave).toBe(false);

    act(() => result.current.handleChange("name", "Local"));
    expect(result.current.canSave).toBe(true);

    act(() => result.current.handleChange("host", ""));
    expect(result.current.canSave).toBe(false);
  });

  it("cannot save a pool sizing the server would refuse", () => {
    const { result } = renderHook(() => useConnectionForm(true));
    act(() => result.current.handleChange("name", "Local"));
    act(() => result.current.handleChange("pool_max", 0));

    expect(result.current.poolProblems.max).toBeDefined();
    expect(result.current.canSave).toBe(false);
  });

  it("starts an edited profile with its password blank", () => {
    // A saved profile's password is never sent back, and an empty one means
    // "keep the stored password" when it goes the other way.
    const { result } = renderHook(() => useConnectionForm(true, saved));
    expect(result.current.form.name).toBe("Prod");
    expect(result.current.form.password).toBe("");
  });

  it("forgets a test result as soon as the form changes", () => {
    // What was tested is no longer what is in the form.
    const { result } = renderHook(() => useConnectionForm(true));
    act(() => {
      void result.current.handleTest();
    });
    act(() => result.current.handleChange("host", "other"));
    expect(result.current.testResult).toBeNull();
  });

  it("reports a failed test rather than throwing it away", async () => {
    apiMocks.testConnection.mockRejectedValue(new Error("Access denied"));
    const { result } = renderHook(() => useConnectionForm(true));

    await act(async () => {
      await result.current.handleTest();
    });

    expect(result.current.testResult?.success).toBe(false);
    expect(result.current.testResult?.message).toContain("Access denied");
  });

  describe("what gets stored", () => {
    const savedProfile = () => saveProfileFn.mock.calls[0][0];

    it("drops the SSH settings when the tunnel is switched off", async () => {
      const { result } = renderHook(() => useConnectionForm(true));
      act(() => result.current.handleChange("name", "Local"));
      act(() => result.current.setSshEnabled(true));
      act(() => result.current.handleSSHChange({ host: "bastion" }));
      act(() => result.current.setSshEnabled(false));

      await act(async () => {
        await result.current.handleSave(() => {});
      });
      expect(savedProfile().ssh_config).toBeNull();
    });

    it("keeps only the fields the chosen auth method uses", async () => {
      // Switching between them used to leave the other's value behind.
      const { result } = renderHook(() => useConnectionForm(true));
      act(() => result.current.handleChange("name", "Local"));
      act(() => result.current.setSshEnabled(true));
      act(() =>
        result.current.handleSSHChange({
          host: "bastion",
          username: "me",
          private_key_path: "/home/me/.ssh/id_ed25519",
        })
      );
      act(() => result.current.setSshAuthMethod("password"));

      await act(async () => {
        await result.current.handleSave(() => {});
      });
      expect(savedProfile().ssh_config.private_key_path).toBeNull();
      expect(savedProfile().ssh_config.host).toBe("bastion");
    });

    it("drops the certificate paths when SSL is disabled", async () => {
      const { result } = renderHook(() => useConnectionForm(true));
      act(() => result.current.handleChange("name", "Local"));
      act(() => result.current.handleSSLChange({ mode: "Required", ca_cert_path: "/tmp/ca.pem" }));
      act(() => result.current.handleSSLChange({ mode: "Disabled" }));

      await act(async () => {
        await result.current.handleSave(() => {});
      });
      expect(savedProfile().ssl_config).toBeNull();
    });

    it("closes only after the save succeeds", async () => {
      const onDone = vi.fn();
      saveProfileFn.mockRejectedValueOnce(new Error("keyring locked"));
      const { result } = renderHook(() => useConnectionForm(true));
      act(() => result.current.handleChange("name", "Local"));

      await act(async () => {
        await result.current.handleSave(onDone);
      });

      // Closing on a failed save loses what the user typed.
      expect(onDone).not.toHaveBeenCalled();
      expect(result.current.saving).toBe(false);
    });
  });

  it("starts fresh when the dialog is reopened", async () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useConnectionForm(open),
      { initialProps: { open: true } },
    );
    act(() => result.current.handleChange("name", "Half typed"));

    rerender({ open: false });
    rerender({ open: true });

    await waitFor(() => {
      expect(result.current.form.name).toBe("");
    });
  });
});

describe("duplicating a profile (FR-1.1.4)", () => {
  it("copies the settings but not the identity", () => {
    const { result } = renderHook(() => useConnectionForm(true, undefined, saved));

    expect(result.current.form.name).toBe("Prod (copy)");
    expect(result.current.form.host).toBe("db.example.com");
    expect(result.current.form.default_database).toBe("shop");
    // A new profile, not an edit of the old one.
    expect(result.current.form.id).not.toBe("p1");
  });

  it("does not carry the password over", () => {
    // It lives in the keyring under the original's id; the copy needs its
    // own, and an empty one here means "no password stored" rather than
    // "keep what is stored", because there is nothing stored for this id.
    const { result } = renderHook(() => useConnectionForm(true, undefined, saved));
    expect(result.current.form.password).toBe("");
  });

  it("can be saved as soon as it is opened", () => {
    // Everything a save needs is already filled in.
    const { result } = renderHook(() => useConnectionForm(true, undefined, saved));
    expect(result.current.canSave).toBe(true);
  });

  it("prefers an edit when both are somehow given", () => {
    const { result } = renderHook(() => useConnectionForm(true, saved, saved));
    expect(result.current.form.id).toBe("p1");
    expect(result.current.form.name).toBe("Prod");
  });
});
