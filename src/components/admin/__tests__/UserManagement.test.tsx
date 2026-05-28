import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { UserManagement } from "../UserManagement";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    executeQuery: vi.fn(),
    getDatabases: vi.fn(),
  },
}));

vi.mock("../CreateUserDialog", () => ({
  CreateUserDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="create-user-dialog">CreateUserDialog</div> : null,
}));

vi.mock("../ChangePasswordDialog", () => ({
  ChangePasswordDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="change-password-dialog">ChangePasswordDialog</div> : null,
}));

import { api } from "../../../lib/tauri-api";

const mockUserResults = (users: Array<Record<string, string | null>>) => [
  {
    query_id: "q1",
    statement_index: 0,
    columns: [
      { name: "User", data_type: "VARCHAR", nullable: false, is_primary_key: false },
      { name: "Host", data_type: "VARCHAR", nullable: false, is_primary_key: false },
      { name: "account_locked", data_type: "STRING", nullable: true, is_primary_key: false },
      { name: "password_expired", data_type: "STRING", nullable: true, is_primary_key: false },
      { name: "password_last_changed", data_type: "STRING", nullable: true, is_primary_key: false },
    ],
    rows: users.map((u) => [u.User, u.Host, u.account_locked ?? null, u.password_expired ?? null, u.password_last_changed ?? null]),
    rows_affected: 0,
    execution_time_ms: 5,
    warnings: [],
    rows_truncated: false,
  },
];

describe("UserManagement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially", async () => {
    vi.mocked(api.executeQuery).mockReturnValue(new Promise(() => {}));
    render(<UserManagement connectionId="conn-1" />);
    expect(screen.getByText("Loading users…")).toBeDefined();
  });

  it("renders user list after loading", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(
      mockUserResults([
        { User: "root", Host: "localhost", account_locked: null, password_expired: null, password_last_changed: null },
        { User: "app", Host: "%", account_locked: "Y", password_expired: null, password_last_changed: null },
      ]),
    );

    render(<UserManagement connectionId="conn-1" />);
    expect(await screen.findByText("root")).toBeDefined();
    expect(screen.getByText("app")).toBeDefined();
    expect(screen.getByText("localhost")).toBeDefined();
  });

  it("shows error on fetch failure", async () => {
    vi.mocked(api.executeQuery).mockRejectedValue("Access denied");
    render(<UserManagement connectionId="conn-1" />);
    expect(await screen.findByText("Access denied")).toBeDefined();
  });

  it("filters users by search", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(
      mockUserResults([
        { User: "root", Host: "localhost", account_locked: null, password_expired: null, password_last_changed: null },
        { User: "app_user", Host: "%", account_locked: null, password_expired: null, password_last_changed: null },
      ]),
    );

    render(<UserManagement connectionId="conn-1" />);
    await screen.findByText("root");

    fireEvent.change(screen.getByPlaceholderText("Filter users…"), {
      target: { value: "app" },
    });

    expect(screen.queryByText("root")).toBeNull();
    expect(screen.getByText("app_user")).toBeDefined();
  });

  it("shows 'No users found' when list is empty", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(mockUserResults([]));
    render(<UserManagement connectionId="conn-1" />);
    expect(await screen.findByText("No users found")).toBeDefined();
  });

  it("shows 'Select a user to view details' initially", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(
      mockUserResults([
        { User: "root", Host: "localhost", account_locked: null, password_expired: null, password_last_changed: null },
      ]),
    );

    render(<UserManagement connectionId="conn-1" />);
    await screen.findByText("root");
    expect(screen.getByText("Select a user to view details")).toBeDefined();
  });

  it("shows user detail when a user row is clicked", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(
      mockUserResults([
        { User: "root", Host: "localhost", account_locked: null, password_expired: null, password_last_changed: null },
      ]),
    );

    render(<UserManagement connectionId="conn-1" />);
    await screen.findByText("root");
    fireEvent.click(screen.getByText("root"));
    expect(screen.getByText(/root@localhost/)).toBeDefined();
    expect(screen.getByText("Grants")).toBeDefined();
    expect(screen.getByText("Privileges")).toBeDefined();
  });

  it("opens CreateUserDialog on New button click", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(mockUserResults([]));
    render(<UserManagement connectionId="conn-1" />);
    await screen.findByText("No users found");

    fireEvent.click(screen.getByText("New"));
    expect(screen.getByTestId("create-user-dialog")).toBeDefined();
  });

  it("shows locked badge for locked users", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(
      mockUserResults([
        { User: "locked_user", Host: "localhost", account_locked: "Y", password_expired: null, password_last_changed: null },
      ]),
    );

    render(<UserManagement connectionId="conn-1" />);
    expect(await screen.findByText("Locked")).toBeDefined();
  });

  it("shows expired badge for expired password users", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(
      mockUserResults([
        { User: "expired_user", Host: "localhost", account_locked: null, password_expired: "Y", password_last_changed: null },
      ]),
    );

    render(<UserManagement connectionId="conn-1" />);
    expect(await screen.findByText("Expired")).toBeDefined();
  });

  it("shows user count in footer", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(
      mockUserResults([
        { User: "root", Host: "localhost", account_locked: null, password_expired: null, password_last_changed: null },
        { User: "app", Host: "%", account_locked: null, password_expired: null, password_last_changed: null },
      ]),
    );

    render(<UserManagement connectionId="conn-1" />);
    await screen.findByText("root");
    expect(screen.getByText("2 users")).toBeDefined();
  });
});
