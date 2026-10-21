import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The restore against the real production guard rather than a mock of it.
 * With the guard mocked, a call that the guard waves through without asking
 * looks the same as one that asks, which is how #789 went unnoticed.
 */

const { connectionState, apiMocks } = vi.hoisted(() => ({
  connectionState: {
    activeConnections: [{
      id: "conn1",
      profile_id: "p1",
      name: "Production",
      host: "localhost",
      port: 3306,
      server_version: "8.0",
      connected_at: "2026-01-01T00:00:00Z",
    }],
    profiles: [{ id: "p1", environment: "production" }],
    selectedConnectionId: "conn1",
  },
  apiMocks: {
    getDatabases: vi.fn(),
    pickFile: vi.fn(),
    readFileHead: vi.fn(),
    restoreDatabase: vi.fn(),
    cancelBackup: vi.fn(),
  },
}));

vi.mock("../../../stores/connectionStore", () => {
  const useConnectionStore = (s: (v: unknown) => unknown) => s(connectionState);
  useConnectionStore.getState = () => connectionState;
  return { useConnectionStore };
});

vi.mock("../../../lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  events: { restoreProgressEvent: { listen: vi.fn().mockResolvedValue(() => {}) } },
}));

vi.mock("../../../lib/tauri-api", () => ({ api: apiMocks }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useProductionGuardStore } from "../../../stores/productionGuardStore";
import { RestoreDialog } from "../RestoreDialog";

describe("RestoreDialog on production", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProductionGuardStore.setState({ pending: null, resolve: null });
    apiMocks.getDatabases.mockResolvedValue([{ name: "shop" }]);
    apiMocks.pickFile.mockResolvedValue("/path/to/shop_backup.sql");
    apiMocks.readFileHead.mockResolvedValue({ text: "", totalBytes: 10, truncated: false });
    apiMocks.restoreDatabase.mockResolvedValue({
      statementsRun: 1,
      statementsFailed: 0,
      bytesRead: 10,
      elapsedMs: 1,
      cancelled: false,
      rolledBack: false,
      partiallyApplied: false,
      errors: [],
    });
  });

  it("asks before restoring, and does not run until confirmed", async () => {
    render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("shop"));
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "shop" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Browse"));
    });
    await waitFor(() => expect(screen.getByText("Restore")).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(screen.getByText("Restore"));
    });

    await waitFor(() => {
      expect(useProductionGuardStore.getState().pending?.title).toBe("Run on production?");
    });
    expect(apiMocks.restoreDatabase).not.toHaveBeenCalled();

    await act(async () => {
      useProductionGuardStore.getState().answer(true);
    });
    await waitFor(() => expect(apiMocks.restoreDatabase).toHaveBeenCalled());
  });
});
