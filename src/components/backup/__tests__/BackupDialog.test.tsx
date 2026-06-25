import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useConnectionStoreFn, generateBackupFn, apiMocks } = vi.hoisted(() => {
  return {
    useConnectionStoreFn: vi.fn(),
    generateBackupFn: vi.fn().mockResolvedValue("-- SQL Dump\n"),
    apiMocks: {
      getDatabases: vi.fn().mockResolvedValue([{ name: "testdb" }, { name: "proddb" }]),
      getTables: vi.fn().mockResolvedValue([
        { name: "users", table_type: "BASE TABLE", row_count: 1000 },
        { name: "orders", table_type: "BASE TABLE", row_count: 500 },
      ]),
      pickSaveFile: vi.fn().mockResolvedValue("/tmp/backup.sql"),
      writeFileContents: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: useConnectionStoreFn,
}));

vi.mock("../../../lib/backup-generator", () => ({
  generateBackup: generateBackupFn,
  defaultBackupOptions: {
    dropTableIfExists: true,
    includeCreateDatabase: false,
    addTableLocks: false,
    includeAutoIncrement: true,
    includeViews: true,
    includeRoutines: true,
    includeTriggers: true,
    includeStructure: true,
    includeData: true,
    multiRowInserts: true,
    insertBatchSize: 100,
  },
}));

vi.mock("../../../lib/tauri-api", () => ({
  api: apiMocks,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { BackupDialog } from "../BackupDialog";

const defaultConnState = {
  activeConnections: [
    {
      id: "conn1",
      profile_id: "p1",
      name: "My DB",
      host: "localhost",
      port: 3306,
      server_version: "8.0",
      connected_at: new Date().toISOString(),
    },
  ],
  selectedConnectionId: "conn1",
};

describe("BackupDialog", () => {
  beforeEach(() => {
    useConnectionStoreFn.mockImplementation((s: (v: unknown) => unknown) => s(defaultConnState));
    apiMocks.pickSaveFile.mockResolvedValue("/tmp/backup.sql");
    apiMocks.writeFileContents.mockResolvedValue(undefined);
    apiMocks.getDatabases.mockResolvedValue([{ name: "testdb" }, { name: "proddb" }]);
    apiMocks.getTables.mockResolvedValue([
      { name: "users", table_type: "BASE TABLE", row_count: 1000 },
      { name: "orders", table_type: "BASE TABLE", row_count: 500 },
    ]);
    generateBackupFn.mockResolvedValue("-- SQL Dump\n");
  });

  describe("visibility", () => {
    it("returns null when isOpen is false", () => {
      const { container } = render(
        <BackupDialog isOpen={false} onClose={vi.fn()} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders dialog when isOpen is true", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByText("Backup Database")).toBeInTheDocument();
    });
  });

  describe("UI elements", () => {
    it("renders Connection and Database labels", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByText("Connection")).toBeInTheDocument();
      expect(screen.getByText("Database")).toBeInTheDocument();
    });

    it("renders Browse button", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByText("Browse")).toBeInTheDocument();
    });

    it("renders Close and Backup buttons", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByText("Close")).toBeInTheDocument();
      expect(screen.getByText("Backup")).toBeInTheDocument();
    });

    it("renders Content radio options", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByText("Structure + Data")).toBeInTheDocument();
      expect(screen.getByText("Structure Only")).toBeInTheDocument();
      expect(screen.getByText("Data Only")).toBeInTheDocument();
    });

    it("renders Insert Format options", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByText(/Multi-row/)).toBeInTheDocument();
    });

    it("renders Options section with checkboxes", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByLabelText("DROP TABLE IF EXISTS")).toBeInTheDocument();
      expect(screen.getByLabelText("Include CREATE DATABASE")).toBeInTheDocument();
      expect(screen.getByLabelText("Add table locks")).toBeInTheDocument();
      expect(screen.getByLabelText("AUTO_INCREMENT values")).toBeInTheDocument();
      expect(screen.getByLabelText("Include views")).toBeInTheDocument();
      expect(screen.getByLabelText("Include procedures/functions")).toBeInTheDocument();
      expect(screen.getByLabelText("Include triggers")).toBeInTheDocument();
    });
  });

  describe("interactions", () => {
    it("calls onClose when Close clicked", () => {
      const onClose = vi.fn();
      render(<BackupDialog isOpen={true} onClose={onClose} />);
      fireEvent.click(screen.getByText("Close"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when overlay clicked", () => {
      const onClose = vi.fn();
      render(<BackupDialog isOpen={true} onClose={onClose} />);
      const overlay = document.querySelector(".bg-black\\/50");
      expect(overlay).toBeTruthy();
      if (overlay) fireEvent.click(overlay);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when X header button clicked", () => {
      const onClose = vi.fn();
      render(<BackupDialog isOpen={true} onClose={onClose} />);

      const xButtons = document.querySelectorAll(".lucide-x");
      // Find the header X button (not the filter clear)
      const headerX = Array.from(xButtons).find(
        (btn) => btn.closest(".justify-between"),
      );
      if (headerX) fireEvent.click(headerX);
      expect(onClose).toHaveBeenCalled();
    });

    it("Backup button is disabled without file path", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      const backupBtn = screen.getByText("Backup");
      expect(backupBtn.closest("button")).toBeDisabled();
    });
  });

  describe("options toggling", () => {
    it("toggles DROP TABLE IF EXISTS when clicked", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      const checkbox = screen.getByLabelText("DROP TABLE IF EXISTS");
      expect(checkbox).toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    it("toggles Include CREATE DATABASE when clicked", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      const checkbox = screen.getByLabelText("Include CREATE DATABASE");
      expect(checkbox).not.toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).toBeChecked();
    });

    it("toggles Include views when clicked", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      const checkbox = screen.getByLabelText("Include views");
      expect(checkbox).toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    it("toggles Include procedures/functions when clicked", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      const checkbox = screen.getByLabelText("Include procedures/functions");
      expect(checkbox).toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    it("toggles Include triggers when clicked", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      const checkbox = screen.getByLabelText("Include triggers");
      expect(checkbox).toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    it("toggles Add table locks when clicked", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      const checkbox = screen.getByLabelText("Add table locks");
      expect(checkbox).not.toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).toBeChecked();
    });

    it("toggles AUTO_INCREMENT values when clicked", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      const checkbox = screen.getByLabelText("AUTO_INCREMENT values");
      expect(checkbox).toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    it("switches to single-row insert format", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("Single row"));
      const singleRowRadio = screen.getByLabelText("Single row") as HTMLInputElement;
      expect(singleRowRadio).toBeChecked();
    });

    it("switches content type to Structure Only", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("Structure Only"));
      const radio = screen.getByLabelText("Structure Only");
      expect(radio).toBeChecked();
    });

    it("switches content type to Data Only", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("Data Only"));
      const radio = screen.getByLabelText("Data Only");
      expect(radio).toBeChecked();
    });

    it("shows batch size input when multi-row is selected", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      // Default is multiRowInserts: true, so batch size input should be visible
      const batchInput = screen.getByRole("spinbutton");
      expect(batchInput).toBeInTheDocument();
      expect((batchInput as HTMLInputElement).value).toBe("100");
    });

    it("hides batch size input when single-row is selected", () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("Single row"));
      expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    });
  });

  describe("database loading", () => {
    it("loads databases when connection changes", async () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => {
        expect(screen.getByText("testdb")).toBeInTheDocument();
        expect(screen.getByText("proddb")).toBeInTheDocument();
      });
    });

    it("clears databases when no connection is present", () => {
      useConnectionStoreFn.mockImplementation((s: (v: unknown) => unknown) =>
        s({ ...defaultConnState, selectedConnectionId: "" })
      );
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      // No databases loaded
      const dbDropdown = screen.getAllByRole("combobox")[1];
      expect(dbDropdown.querySelectorAll("option").length).toBe(1); // only "Select database..."
    });
  });

  describe("preselected connection/database", () => {
    it("uses preselected connectionId and database", () => {
      useConnectionStoreFn.mockImplementation((s: (v: unknown) => unknown) => s(defaultConnState));
      render(
        <BackupDialog
          isOpen={true}
          onClose={vi.fn()}
          preSelectedConnectionId="conn1"
          preSelectedDatabase="preselected_db"
        />,
      );
      expect(screen.getByText("Backup Database")).toBeInTheDocument();
    });
  });

  describe("table selection", () => {
    it("shows table selection after database selection", async () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      await waitFor(() => {
        expect(screen.getByText(/All Tables/)).toBeInTheDocument();
      });
    });

    it("shows All Tables checkbox checked by default", async () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      await waitFor(() => {
        const allTablesCheckbox = screen.getByRole("checkbox", { name: /All Tables/ }) as HTMLInputElement;
        expect(allTablesCheckbox).toBeChecked();
      });
    });

    it("shows individual table checkboxes when All Tables is unchecked", async () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      await waitFor(() => screen.getByRole("checkbox", { name: /All Tables/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /All Tables/ }));

      await waitFor(() => {
        expect(screen.getByText("users")).toBeInTheDocument();
        expect(screen.getByText("orders")).toBeInTheDocument();
      });
    });

    it("deselects individual tables", async () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      await waitFor(() => screen.getByRole("checkbox", { name: /All Tables/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /All Tables/ }));

      await waitFor(() => screen.getByText("users"));
      // Find individual table checkboxes (not the All Tables one)
      const allCheckboxes = screen.getAllByRole("checkbox");
      const tableCbs = allCheckboxes.filter(
        (cb) => !(cb as HTMLInputElement).id && cb !== allCheckboxes[0],
      );
      expect(tableCbs.length).toBeGreaterThanOrEqual(2);
      const userCb = tableCbs[0] as HTMLInputElement;
      expect(userCb).toBeChecked();
      fireEvent.click(userCb);
      expect(userCb).not.toBeChecked();
    });

    it("re-checks All Tables reselects all tables", async () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      await waitFor(() => screen.getByRole("checkbox", { name: /All Tables/ }));
      // Uncheck All Tables
      fireEvent.click(screen.getByRole("checkbox", { name: /All Tables/ }));
      // Re-check All Tables
      fireEvent.click(screen.getByRole("checkbox", { name: /All Tables/ }));
      // Should be checked again
      expect(screen.getByRole("checkbox", { name: /All Tables/ })).toBeChecked();
    });
  });

  describe("backup flow", () => {
    it("starts backup when Backup button is clicked with file selected", async () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      const browseBtn = screen.getByText("Browse");
      await act(async () => {
        fireEvent.click(browseBtn);
      });

      await waitFor(() => {
        const backupBtn = screen.getByText("Backup").closest("button");
        expect(backupBtn).not.toBeDisabled();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Backup"));
      });

      await waitFor(() => {
        expect(generateBackupFn).toHaveBeenCalled();
      });
    });

    it("shows error message when backup fails", async () => {
      generateBackupFn.mockRejectedValueOnce(new Error("Connection lost"));

      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Browse"));
      });

      await waitFor(() => {
        expect(screen.getByText("Backup").closest("button")).not.toBeDisabled();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Backup"));
      });

      await waitFor(() => {
        expect(screen.getByText(/Error/)).toBeInTheDocument();
      });
    });

    it("shows done message after successful backup", async () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Browse"));
      });

      await waitFor(() => {
        expect(screen.getByText("Backup").closest("button")).not.toBeDisabled();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Backup"));
      });

      await waitFor(() => {
        expect(screen.getByText(/Backup completed/)).toBeInTheDocument();
      });
    });

    it("shows Cancel button during backup", async () => {
      // Make generateBackup hang by returning a never-resolving promise
      let resolveBackup: (value: string) => void;
      generateBackupFn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveBackup = resolve;
          }),
      );

      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Browse"));
      });

      await waitFor(() => {
        expect(screen.getByText("Backup").closest("button")).not.toBeDisabled();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Backup"));
      });

      await waitFor(() => {
        expect(screen.getByText("Cancel")).toBeInTheDocument();
      });

      // Now resolve to clean up
      resolveBackup!("-- SQL\n");
    });

    it("cancels backup when Cancel is clicked", async () => {
      let resolveBackup: (value: string) => void;
      generateBackupFn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveBackup = resolve;
          }),
      );

      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Browse"));
      });

      await waitFor(() => {
        expect(screen.getByText("Backup").closest("button")).not.toBeDisabled();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Backup"));
      });

      await waitFor(() => screen.getByText("Cancel"));
      fireEvent.click(screen.getByText("Cancel"));

      // Now resolve
      resolveBackup!("-- SQL\n");
    });

    it("shows no tables selected error when backup called with none selected", async () => {
      render(<BackupDialog isOpen={true} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("testdb"));

      const dbDropdown = screen.getAllByRole("combobox")[1];
      fireEvent.change(dbDropdown, { target: { value: "testdb" } });

      await waitFor(() => screen.getByRole("checkbox", { name: /All Tables/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /All Tables/ }));
      await waitFor(() => screen.getByText(/users/));

      // Uncheck individual tables using checkboxes
      const allCheckboxes = screen.getAllByRole("checkbox");
      const tableCbs = allCheckboxes.filter(
        (cb) => !(cb as HTMLInputElement).id && cb !== allCheckboxes[0],
      );
      if (tableCbs.length >= 2) {
        fireEvent.click(tableCbs[0]); // users
        fireEvent.click(tableCbs[1]); // orders
      }

      await act(async () => {
        fireEvent.click(screen.getByText("Browse"));
      });

      await waitFor(() => {
        expect(screen.getByText("Backup").closest("button")).not.toBeDisabled();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Backup"));
      });

      await waitFor(() => {
        expect(screen.getByText("No tables selected")).toBeInTheDocument();
      });
    });
  });
});
