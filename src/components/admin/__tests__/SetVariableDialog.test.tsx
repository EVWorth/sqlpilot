import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runStatement = vi.hoisted(() => vi.fn());
const connState = { activeConnections: [] as any[], profiles: [] as any[] };

vi.mock("../../../lib/run-statement", () => ({ runStatement }));
vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: { getState: () => connState },
}));

import { useProductionGuardStore } from "../../../stores/productionGuardStore";
import { SetVariableDialog } from "../SetVariableDialog";

const variable = {
  name: "max_connections",
  value: "151",
  description: "The number of simultaneous client connections allowed.",
  readOnly: false,
};

function open(overrides = {}) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <SetVariableDialog
      variable={variable}
      connectionId="conn-1"
      flavour="mysql"
      onClose={onClose}
      onChanged={onChanged}
      {...overrides}
    />,
  );
  return { onClose, onChanged };
}

describe("SetVariableDialog (#438)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runStatement.mockResolvedValue([]);
    connState.activeConnections = [];
    connState.profiles = [];
    useProductionGuardStore.setState({ pending: null, resolve: null });
  });

  it("renders nothing without a variable", () => {
    const { container } = render(
      <SetVariableDialog
        variable={null}
        connectionId="conn-1"
        flavour="mysql"
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("seeds the current value and shows the description", () => {
    open();
    expect(screen.getByLabelText("Value")).toHaveValue("151");
    expect(screen.getByText(/simultaneous client connections/)).toBeInTheDocument();
  });

  it("cannot apply an unchanged value", () => {
    open();
    expect(screen.getByText("Apply")).toBeDisabled();
  });

  it("shows the statement it will run", () => {
    open();
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "500" } });
    expect(screen.getByText("SET GLOBAL max_connections = 500;")).toBeInTheDocument();
  });

  it("warns that a global change does not survive a restart", () => {
    // The thing people are surprised by: it holds until the server stops.
    open();
    expect(screen.getByText(/holds until the server restarts/)).toBeInTheDocument();
    expect(screen.getByText(/Set the scope to persist it/)).toBeInTheDocument();
  });

  it("tells MariaDB users to edit the config instead", () => {
    // MariaDB has no SET PERSIST, so pointing at it would be useless advice.
    open({ flavour: "mariadb" });
    expect(screen.getByText(/MariaDB has no SET PERSIST/)).toBeInTheDocument();
  });

  it("does not offer PERSIST on MariaDB", () => {
    open({ flavour: "mariadb" });
    const scope = screen.getByLabelText("Scope") as HTMLSelectElement;
    const values = [...scope.options].map((o) => o.value);
    expect(values).toEqual(["global", "session"]);
  });

  it("offers PERSIST on MySQL", () => {
    open();
    const scope = screen.getByLabelText("Scope") as HTMLSelectElement;
    expect([...scope.options].map((o) => o.value)).toContain("persist");
  });

  it("drops the restart warning once the change will persist", () => {
    open();
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "persist" } });
    expect(screen.queryByText(/holds until the server restarts/)).not.toBeInTheDocument();
  });

  it("applies the change and reloads", async () => {
    const { onChanged, onClose } = open();
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "500" } });

    fireEvent.click(screen.getByText("Apply"));

    await waitFor(() =>
      expect(runStatement).toHaveBeenCalledWith(
        expect.objectContaining({ sql: "SET GLOBAL max_connections = 500" }),
      )
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces the server's refusal for a read-only variable", async () => {
    // MySQL reports read-only only by failing the SET with 1238 — there is no
    // column to check first.
    runStatement.mockRejectedValue(new Error("Variable 'version' is a read only variable"));
    const { onClose } = open();
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "9" } });

    fireEvent.click(screen.getByText("Apply"));

    expect(await screen.findByRole("alert")).toHaveTextContent("read only variable");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks before changing a variable on production", async () => {
    connState.activeConnections = [{ id: "conn-1", profile_id: "p1", name: "prod" }];
    connState.profiles = [{ id: "p1", environment: "production" }];
    open();
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "500" } });

    fireEvent.click(screen.getByText("Apply"));

    await waitFor(() => expect(useProductionGuardStore.getState().pending).not.toBeNull());
    expect(runStatement).not.toHaveBeenCalled();
  });
});
