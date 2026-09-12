import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestoreSummary } from "../../../lib/bindings";

const clean: RestoreSummary = {
  statementsRun: 12,
  statementsFailed: 0,
  bytesRead: 4096,
  elapsedMs: 2000,
  cancelled: false,
  rolledBack: false,
  partiallyApplied: false,
  errors: [],
};

const { useConnectionStoreFn, listenFn, confirmFn, apiMocks } = vi.hoisted(() => ({
  useConnectionStoreFn: vi.fn(),
  listenFn: vi.fn(),
  confirmFn: vi.fn(),
  apiMocks: {
    getDatabases: vi.fn(),
    pickFile: vi.fn(),
    readFileHead: vi.fn(),
    restoreDatabase: vi.fn(),
    cancelBackup: vi.fn(),
  },
}));

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: useConnectionStoreFn,
}));

vi.mock("../../../stores/productionGuardStore", () => ({
  confirmDestructive: confirmFn,
}));

vi.mock("../../../lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  events: { restoreProgressEvent: { listen: listenFn } },
}));

vi.mock("../../../lib/tauri-api", () => ({ api: apiMocks }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { RestoreDialog } from "../RestoreDialog";

/** Pick a file and start a restore, which is the preamble to most of these. */
async function startRestore() {
  render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
  await waitFor(() => screen.getByText("testdb"));
  fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "testdb" } });

  await act(async () => {
    fireEvent.click(screen.getByText("Browse"));
  });
  await waitFor(() => {
    expect(screen.getByText("Restore")).not.toBeDisabled();
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Restore"));
  });
}

describe("RestoreDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
      s({
        activeConnections: [{
          id: "conn1",
          profile_id: "p1",
          name: "My DB",
          host: "localhost",
          port: 3306,
          server_version: "8.0",
          connected_at: new Date().toISOString(),
        }],
        selectedConnectionId: "conn1",
      })
    );
    apiMocks.getDatabases.mockResolvedValue([{ name: "testdb" }]);
    apiMocks.pickFile.mockResolvedValue("/path/to/dump.sql");
    apiMocks.readFileHead.mockResolvedValue({
      text: "CREATE TABLE users (id INT);\n",
      totalBytes: 2048,
      truncated: false,
    });
    apiMocks.restoreDatabase.mockResolvedValue({ ...clean });
    apiMocks.cancelBackup.mockResolvedValue(true);
    listenFn.mockResolvedValue(() => {});
    confirmFn.mockResolvedValue(true);
  });

  it("returns null when isOpen is false", () => {
    const { container } = render(<RestoreDialog isOpen={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the dialog when open", () => {
    render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Restore Database")).toBeInTheDocument();
    expect(screen.getByText("Connection")).toBeInTheDocument();
  });

  it("cannot restore before a file is chosen", () => {
    render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Restore")).toBeDisabled();
  });

  it("calls onClose when Close is clicked", () => {
    const onClose = vi.fn();
    render(<RestoreDialog isOpen={true} onClose={onClose} />);
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("choosing a file", () => {
    it("reads only the head of it for the preview", async () => {
      // Reading a multi-gigabyte dump into the renderer to draw thirty lines
      // is what the streaming restore exists to avoid (#358).
      render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
      await act(async () => {
        fireEvent.click(screen.getByText("Browse"));
      });

      expect(apiMocks.readFileHead).toHaveBeenCalledWith("/path/to/dump.sql", 64 * 1024);
      await waitFor(() => {
        expect(screen.getByText(/2.0 KB/)).toBeInTheDocument();
      });
    });

    it("reports a file it cannot read instead of failing silently", async () => {
      apiMocks.readFileHead.mockRejectedValueOnce(new Error("No such file"));
      render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
      await act(async () => {
        fireEvent.click(screen.getByText("Browse"));
      });
      await waitFor(() => {
        expect(screen.getByText(/No such file/)).toBeInTheDocument();
      });
    });
  });

  describe("running it", () => {
    it("asks before running the most destructive thing the app does", async () => {
      confirmFn.mockResolvedValueOnce(false);
      await startRestore();
      expect(confirmFn).toHaveBeenCalled();
      expect(apiMocks.restoreDatabase).not.toHaveBeenCalled();
    });

    it("hands the whole file to the backend rather than statement by statement", async () => {
      await startRestore();
      await waitFor(() => {
        expect(apiMocks.restoreDatabase).toHaveBeenCalledWith(
          expect.any(String),
          "conn1",
          "testdb",
          "/path/to/dump.sql",
          expect.objectContaining({ stopOnError: true }),
        );
      });
    });

    it("says how much ran when it worked", async () => {
      await startRestore();
      await waitFor(() => {
        expect(screen.getByText(/Restore complete — 12 statements/)).toBeInTheDocument();
      });
    });

    it("says the database is unchanged when everything rolled back", async () => {
      apiMocks.restoreDatabase.mockResolvedValueOnce({
        ...clean,
        statementsRun: 2,
        statementsFailed: 1,
        rolledBack: true,
        partiallyApplied: false,
        errors: ["Statement 3: Duplicate entry '1'"],
      });
      await startRestore();
      await waitFor(() => {
        expect(screen.getByText(/the database is as it was/)).toBeInTheDocument();
      });
      expect(screen.getByText(/Duplicate entry/)).toBeInTheDocument();
    });

    it("says plainly when part of the file already applied", async () => {
      // The thing the old dialog never said. A rollback does not undo a
      // CREATE, because MySQL commits before every DDL statement.
      apiMocks.restoreDatabase.mockResolvedValueOnce({
        ...clean,
        statementsRun: 5,
        statementsFailed: 1,
        rolledBack: true,
        partiallyApplied: true,
        errors: ["Statement 6: Unknown column"],
      });
      await startRestore();
      await waitFor(() => {
        expect(screen.getByText(/part of the file had already been applied/))
          .toBeInTheDocument();
      });
    });

    it("reports a restore that could not start at all", async () => {
      apiMocks.restoreDatabase.mockRejectedValueOnce(new Error("read-only connection"));
      await startRestore();
      await waitFor(() => {
        expect(screen.getByText(/read-only connection/)).toBeInTheDocument();
      });
    });

    it("can be cancelled while it runs", async () => {
      let finish: (value: unknown) => void;
      apiMocks.restoreDatabase.mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      await startRestore();

      await waitFor(() => screen.getByText("Cancel"));
      fireEvent.click(screen.getByText("Cancel"));
      expect(apiMocks.cancelBackup).toHaveBeenCalled();

      await act(async () => {
        finish!({ ...clean, cancelled: true, statementsRun: 3, partiallyApplied: true });
      });
      await waitFor(() => {
        expect(screen.getByText(/Restore cancelled/)).toBeInTheDocument();
      });
    });
  });

  describe("options", () => {
    it("defaults to stopping on error, ignoring key order and using a transaction", async () => {
      render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByRole("checkbox", { name: /Stop on error/ })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /foreign-key order/ })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /transaction/ })).toBeChecked();
    });

    it("sends what was unticked", async () => {
      render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));
      fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "testdb" } });
      fireEvent.click(screen.getByRole("checkbox", { name: /Stop on error/ }));

      await act(async () => {
        fireEvent.click(screen.getByText("Browse"));
      });
      await act(async () => {
        fireEvent.click(screen.getByText("Restore"));
      });

      await waitFor(() => {
        expect(apiMocks.restoreDatabase).toHaveBeenCalledWith(
          expect.any(String),
          "conn1",
          "testdb",
          "/path/to/dump.sql",
          expect.objectContaining({ stopOnError: false }),
        );
      });
    });
  });
});
