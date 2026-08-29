import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    rows: users.map((
      u,
    ) => [u.User, u.Host, u.account_locked ?? null, u.password_expired ?? null, u.password_last_changed ?? null]),
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
        {
          User: "locked_user",
          Host: "localhost",
          account_locked: "Y",
          password_expired: null,
          password_last_changed: null,
        },
      ]),
    );

    render(<UserManagement connectionId="conn-1" />);
    expect(await screen.findByText("Locked")).toBeDefined();
  });

  it("shows expired badge for expired password users", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(
      mockUserResults([
        {
          User: "expired_user",
          Host: "localhost",
          account_locked: null,
          password_expired: "Y",
          password_last_changed: null,
        },
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

describe("degraded user status (#440)", () => {
  it("marks lock and expiry as unknown when the full query fails", async () => {
    // MariaDB and restricted grants lack some of those columns. The fallback
    // fills them with null, which rendered as "no badge" — indistinguishable
    // from an account that is genuinely fine. A locked account looking
    // unremarkable is the dangerous reading on an admin screen.
    vi.mocked(api.executeQuery).mockImplementation((_conn: string, sql: string) => {
      if (sql.includes("account_locked")) {
        return Promise.reject(new Error("Unknown column 'account_locked'"));
      }
      return Promise.resolve([
        {
          query_id: "q1",
          statement_index: 0,
          columns: [
            { name: "User", data_type: "VARCHAR", nullable: false, is_primary_key: false },
            { name: "Host", data_type: "VARCHAR", nullable: false, is_primary_key: false },
          ],
          rows: [["alice", "%"]],
          rows_affected: 0,
          execution_time_ms: 1,
          warnings: [],
          rows_truncated: false,
        },
      ]) as never;
    });

    render(<UserManagement connectionId="c1" />);
    expect(await screen.findByText("alice")).toBeDefined();
    expect(screen.getByText("unknown")).toBeDefined();
  });

  it("shows no unknown marker when the full query succeeds", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(
      mockUserResults([{ User: "alice", Host: "%" }]) as never,
    );

    render(<UserManagement connectionId="c1" />);
    expect(await screen.findByText("alice")).toBeDefined();
    expect(screen.queryByText("unknown")).toBeNull();
  });
});

describe("per-database privilege edits (#441)", () => {
  /** SHOW GRANTS / user-list / database-list responses for the editor. */
  function wireEditor() {
    vi.mocked(api.getDatabases).mockResolvedValue([{ name: "db1" }, { name: "db2" }] as never);
    vi.mocked(api.executeQuery).mockImplementation((_conn: string, sql: string) => {
      if (sql.startsWith("SHOW GRANTS")) {
        return Promise.resolve([
          {
            query_id: "g",
            statement_index: 0,
            columns: [{ name: "Grants", data_type: "VARCHAR", nullable: false, is_primary_key: false }],
            rows: [["GRANT USAGE ON *.* TO 'alice'@'%'"]],
            rows_affected: 0,
            execution_time_ms: 1,
            warnings: [],
            rows_truncated: false,
          },
        ]) as never;
      }
      return Promise.resolve(mockUserResults([{ User: "alice", Host: "%" }])) as never;
    });
  }

  async function openPrivileges() {
    render(<UserManagement connectionId="c1" />);
    fireEvent.click(await screen.findByText("alice"));
    fireEvent.click(await screen.findByText("Privileges"));
    const select = await screen.findByRole("combobox");
    // The database list loads asynchronously; changing the select before its
    // options exist silently does nothing.
    await screen.findByRole("option", { name: /db1/ });
    return select;
  }

  /**
   * The database section only. The global privilege checkboxes come first in
   * the DOM, so an unscoped getAllByRole("checkbox")[0] is a *global* toggle —
   * which would persist across a database switch no matter what, and make this
   * test pass for the wrong reason.
   */
  function dbSection() {
    return within(screen.getByTestId("db-privileges"));
  }

  it("keeps edits when switching to another database and back", async () => {
    // Toggling on db1, switching to db2, then back used to reload db1 fresh
    // and silently discard the edit.
    wireEditor();
    const select = await openPrivileges();

    await act(async () => {
      fireEvent.change(select, { target: { value: "db1" } });
    });
    await act(async () => {
      fireEvent.click(dbSection().getAllByRole("checkbox")[0]);
    });
    expect((dbSection().getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);

    await act(async () => {
      fireEvent.change(select, { target: { value: "db2" } });
    });
    await act(async () => {
      fireEvent.change(select, { target: { value: "db1" } });
    });

    expect((dbSection().getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);
  });

  it("says which databases have unapplied changes", async () => {
    wireEditor();
    const select = await openPrivileges();
    await act(async () => {
      fireEvent.change(select, { target: { value: "db1" } });
    });
    await act(async () => {
      fireEvent.click(dbSection().getAllByRole("checkbox")[0]);
    });
    await act(async () => {
      fireEvent.change(select, { target: { value: "db2" } });
    });

    // The edit is on a database that is no longer on screen, so the UI has to
    // say so — otherwise Apply sends changes the user cannot see.
    expect(await screen.findByText(/unapplied changes on db1/)).toBeDefined();
  });
});
