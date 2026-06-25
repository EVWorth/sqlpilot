import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RestoreDialog } from "../RestoreDialog";

const { useConnectionStoreFn } = vi.hoisted(() => {
  return { useConnectionStoreFn: vi.fn() };
});

vi.mock("../../stores/connectionStore", () => ({
  useConnectionStore: useConnectionStoreFn,
}));

vi.mock("../../lib/tauri-api", () => ({
  api: {
    getDatabases: vi.fn().mockResolvedValue([{ name: "testdb" }]),
    pickFile: vi.fn().mockResolvedValue("/path/to/dump.sql"),
    readFileContents: vi.fn().mockResolvedValue("CREATE TABLE users (id INT);"),
    executeQuery: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../../lib/sql-import", () => ({
  splitSqlStatements: vi.fn(() => ["CREATE TABLE users (id INT)"]),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(() => {
  useConnectionStoreFn.mockImplementation((s: (v: any) => unknown) =>
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
});

describe("RestoreDialog", () => {
  it("returns null when isOpen is false", () => {
    const { container } = render(<RestoreDialog isOpen={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders dialog when isOpen is true", () => {
    render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Restore Database")).toBeInTheDocument();
  });

  it("renders Connection label", () => {
    render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Connection")).toBeInTheDocument();
  });

  it("renders Browse button", () => {
    render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Browse")).toBeInTheDocument();
  });

  it("renders Stop on error checkbox checked", () => {
    render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("Restore button disabled when no file", () => {
    render(<RestoreDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Restore")).toBeDisabled();
  });

  it("calls onClose when Close clicked", () => {
    const onClose = vi.fn();
    render(<RestoreDialog isOpen={true} onClose={onClose} />);
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
