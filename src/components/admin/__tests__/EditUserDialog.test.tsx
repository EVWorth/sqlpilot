import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runStatement = vi.hoisted(() => vi.fn());
const connState = { activeConnections: [] as any[], profiles: [] as any[] };

vi.mock("../../../lib/run-statement", () => ({ runStatement }));
vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: { getState: () => connState },
}));

import { useProductionGuardStore } from "../../../stores/productionGuardStore";
import { EditUserDialog } from "../EditUserDialog";

const props = {
  isOpen: true,
  onClose: vi.fn(),
  onSaved: vi.fn(),
  connectionId: "conn-1",
  username: "app",
  host: "%",
};

function open(overrides = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<EditUserDialog {...props} onClose={onClose} onSaved={onSaved} {...overrides} />);
  return { onClose, onSaved };
}

/** The statements the dialog says it will run. */
function preview() {
  return screen.queryByText(/^ALTER USER|^RENAME USER/)?.textContent ?? "";
}

describe("EditUserDialog (#436)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runStatement.mockResolvedValue([]);
    connState.activeConnections = [];
    connState.profiles = [];
    useProductionGuardStore.setState({ pending: null, resolve: null });
  });

  afterEach(() => {
    vi.mocked(props.onClose).mockClear();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<EditUserDialog {...props} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("starts with every control unchanged and nothing to apply", () => {
    // On MariaDB the panel cannot read lock or expiry state, so a pre-filled
    // form would be pre-filled with guesses (#440).
    open();

    expect(screen.getByLabelText("Account")).toHaveValue("unchanged");
    expect(screen.getByLabelText("Password expiry")).toHaveValue("unchanged");
    expect(screen.getByText("Apply")).toBeDisabled();
  });

  it("shows the statements it is about to run", () => {
    open();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "unlock" } });

    expect(preview()).toContain("ALTER USER 'app'@'%' ACCOUNT UNLOCK");
    expect(screen.getByText("Apply")).not.toBeDisabled();
  });

  it("offers a day count only for an interval", () => {
    open();
    expect(screen.queryByLabelText("Days")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Password expiry"), { target: { value: "interval" } });
    expect(screen.getByLabelText("Days")).toBeInTheDocument();
  });

  it("applies each change as its own statement", async () => {
    // Both servers reject the combined form, and one statement per change
    // means a failure can name which one.
    const { onClose } = open();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "lock" } });
    fireEvent.change(screen.getByLabelText("Password expiry"), { target: { value: "never" } });

    fireEvent.click(screen.getByText("Apply"));

    await waitFor(() => expect(runStatement).toHaveBeenCalledTimes(2));
    expect(runStatement.mock.calls[0][0].sql).toContain("ACCOUNT LOCK");
    expect(runStatement.mock.calls[1][0].sql).toContain("PASSWORD EXPIRE NEVER");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("treats a blank connection limit as unchanged, not as zero", () => {
    // Zero means unlimited to MySQL, so reading blank as zero would silently
    // remove a limit somebody set.
    open();
    expect(screen.getByText("Apply")).toBeDisabled();
  });

  it("applies a connection limit of zero when it is asked for", () => {
    open();
    fireEvent.change(screen.getByLabelText(/Max connections/), { target: { value: "0" } });

    expect(preview()).toContain("WITH MAX_USER_CONNECTIONS 0");
  });

  it("renames when the host changes, and not when it does not", () => {
    open();
    const host = screen.getByLabelText(/^Host/);

    fireEvent.change(host, { target: { value: "localhost" } });
    expect(preview()).toContain("RENAME USER 'app'@'%' TO 'app'@'localhost'");

    fireEvent.change(host, { target: { value: "%" } });
    expect(screen.getByText("Apply")).toBeDisabled();
  });

  it("says how much was applied when one statement fails", async () => {
    // ALTER USER commits as it runs, so "it failed" would be wrong about the
    // part that took.
    runStatement.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("denied"));
    const { onSaved } = open();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "lock" } });
    fireEvent.change(screen.getByLabelText("Password expiry"), { target: { value: "never" } });

    fireEvent.click(screen.getByText("Apply"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Applied 1 of 2");
    // The list still refreshes: one change did land.
    expect(onSaved).toHaveBeenCalled();
  });

  it("says nothing was changed when the first statement fails", async () => {
    runStatement.mockRejectedValue(new Error("denied"));
    open();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "lock" } });

    fireEvent.click(screen.getByText("Apply"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was changed");
  });

  it("asks once before changing a production account", async () => {
    connState.activeConnections = [{ id: "conn-1", profile_id: "p1", name: "prod" }];
    connState.profiles = [{ id: "p1", environment: "production" }];
    open();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "lock" } });

    fireEvent.click(screen.getByText("Apply"));

    await waitFor(() => expect(useProductionGuardStore.getState().pending).not.toBeNull());
    expect(runStatement).not.toHaveBeenCalled();
  });

  it("changes nothing when the production prompt is declined", async () => {
    connState.activeConnections = [{ id: "conn-1", profile_id: "p1", name: "prod" }];
    connState.profiles = [{ id: "p1", environment: "production" }];
    open();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "lock" } });
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(useProductionGuardStore.getState().pending).not.toBeNull());

    useProductionGuardStore.getState().answer(false);

    await waitFor(() => expect(useProductionGuardStore.getState().pending).toBeNull());
    expect(runStatement).not.toHaveBeenCalled();
  });
});
