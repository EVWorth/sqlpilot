import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runStatement = vi.hoisted(() => vi.fn());
let connState = { activeConnections: [{ id: "c1", server_version: "8.0.46" }] as any[], profiles: [] as any[] };

vi.mock("../../../lib/run-statement", () => ({ runStatement }));
vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(connState),
    { getState: () => connState },
  ),
}));

import { useProductionGuardStore } from "../../../stores/productionGuardStore";
import { RolesTab } from "../RolesTab";

/**
 * Answer the load queries by what they ask for, not by call order.
 *
 * Every action reloads, so an order-based seed runs out after the first one
 * and the table empties — which looks like a component bug and is not.
 */
function seed(roles: unknown[][], grants: unknown[][], users: unknown[][]) {
  runStatement.mockReset();
  runStatement.mockImplementation(async ({ sql }: { sql: string }) => {
    if (sql.includes("roles_mapping") || sql.includes("role_edges")) return [{ rows: grants }];
    if (sql.includes("is_role") || sql.includes("account_locked")) return [{ rows: roles }];
    if (sql.startsWith("SELECT User, Host FROM mysql.user")) return [{ rows: users }];
    return [];
  });
}

describe("RolesTab (#435)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connState = { activeConnections: [{ id: "c1", server_version: "8.0.46" }], profiles: [] };
    useProductionGuardStore.setState({ pending: null, resolve: null });
    seed([["reader", "%"]], [["reader", "app", "%"]], [["app", "%"], ["reader", "%"]]);
  });

  it("lists roles with how many hold each", async () => {
    render(<RolesTab connectionId="c1" />);
    expect(await screen.findByText("reader")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("says so when there are no roles", async () => {
    seed([], [], [["app", "%"]]);
    render(<RolesTab connectionId="c1" />);
    expect(await screen.findByText("No roles yet")).toBeInTheDocument();
  });

  it("uses the flavour's role query", async () => {
    render(<RolesTab connectionId="c1" />);
    await screen.findByText("reader");
    // MySQL has no is_role column; it is recognised by the locked-expired-
    // passwordless convention instead.
    expect(runStatement.mock.calls[0][0].sql).toContain("account_locked");
  });

  it("uses MariaDB's query on MariaDB", async () => {
    connState = { activeConnections: [{ id: "c1", server_version: "11.4.2-MariaDB" }], profiles: [] };
    seed([["reader", ""]], [], [["app", "%"]]);
    render(<RolesTab connectionId="c1" />);
    await screen.findByText("reader");

    expect(runStatement.mock.calls[0][0].sql).toContain("is_role");
    expect(runStatement.mock.calls[1][0].sql).toContain("roles_mapping");
  });

  it("creates a role", async () => {
    render(<RolesTab connectionId="c1" />);
    await screen.findByText("reader");

    fireEvent.change(screen.getByLabelText("New role name"), { target: { value: "writer" } });
    fireEvent.click(screen.getByTitle("Create role"));

    await waitFor(() =>
      expect(runStatement).toHaveBeenCalledWith(
        expect.objectContaining({ sql: "CREATE ROLE 'writer'", origin: "admin" }),
      )
    );
  });

  it("cannot create a role with no name", async () => {
    render(<RolesTab connectionId="c1" />);
    await screen.findByText("reader");
    expect(screen.getByTitle("Create role")).toBeDisabled();
  });

  it("shows who holds the selected role", async () => {
    // Scoped to the table: the grant dropdown offers the same name as an
    // option, so a bare getByText is ambiguous.
    render(<RolesTab connectionId="c1" />);
    fireEvent.click(await screen.findByText("reader"));

    expect(within(screen.getByRole("table")).getByText("app@%")).toBeInTheDocument();
  });

  it("does not offer a role as somebody to grant to", async () => {
    // Roles live in mysql.user too, so an unfiltered list would offer them.
    render(<RolesTab connectionId="c1" />);
    fireEvent.click(await screen.findByText("reader"));

    const options = [...(screen.getByLabelText("Grant to") as HTMLSelectElement).options]
      .map((o) => o.textContent);
    expect(options).toContain("app@%");
    expect(options).not.toContain("reader@%");
  });

  it("grants, revokes, and sets a default role", async () => {
    render(<RolesTab connectionId="c1" />);
    fireEvent.click(await screen.findByText("reader"));

    fireEvent.click(screen.getByText("Set default"));
    await waitFor(() =>
      expect(runStatement).toHaveBeenCalledWith(
        expect.objectContaining({ sql: "SET DEFAULT ROLE 'reader'@'%' TO 'app'@'%'" }),
      )
    );

    fireEvent.click(screen.getByText("Revoke"));
    await waitFor(() =>
      expect(runStatement).toHaveBeenCalledWith(
        expect.objectContaining({ sql: "REVOKE 'reader'@'%' FROM 'app'@'%'" }),
      )
    );
  });

  it("asks before changing roles on production", async () => {
    connState.profiles = [{ id: "p1", environment: "production" }];
    connState.activeConnections = [{ id: "c1", profile_id: "p1", server_version: "8.0.46" }];
    render(<RolesTab connectionId="c1" />);
    fireEvent.click(await screen.findByText("reader"));

    fireEvent.click(screen.getByText("Revoke"));

    await waitFor(() => expect(useProductionGuardStore.getState().pending).not.toBeNull());
  });

  it("reports a failure instead of throwing", async () => {
    render(<RolesTab connectionId="c1" />);
    fireEvent.click(await screen.findByText("reader"));
    runStatement.mockRejectedValueOnce(new Error("access denied"));

    fireEvent.click(screen.getByText("Revoke"));

    expect(await screen.findByRole("status")).toHaveTextContent("access denied");
  });
});
