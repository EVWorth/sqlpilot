import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProductionGuardStore } from "../../../stores/productionGuardStore";
import { CreateUserDialog } from "../CreateUserDialog";

// The production guard reads these; without them it cannot tell whether the
// connection is production (#456).
const connState = { activeConnections: [] as any[], profiles: [] as any[] };

vi.mock("../../../stores/connectionStore", () => ({
  // The component selects from it as a hook; the guard reads getState().
  useConnectionStore: Object.assign(
    (selector?: (s: unknown) => unknown) => (selector ? selector(connState) : connState),
    { getState: () => connState },
  ),
}));

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    executeQuery: vi.fn(),
  },
}));

import { api } from "../../../lib/tauri-api";

const mockProps = {
  isOpen: true,
  onClose: vi.fn(),
  connectionId: "conn-1",
  onCreated: vi.fn(),
};

describe("CreateUserDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders null when not open", () => {
    const { container } = render(
      <CreateUserDialog {...mockProps} isOpen={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders dialog with title 'Create User'", () => {
    render(<CreateUserDialog {...mockProps} />);
    // The dialog has both a heading "Create User" and a button "Create User"
    const elements = screen.getAllByText("Create User");
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it("renders username input", () => {
    render(<CreateUserDialog {...mockProps} />);
    expect(screen.getByPlaceholderText("e.g. app_user")).toBeDefined();
  });

  it("renders host select with default '%'", () => {
    render(<CreateUserDialog {...mockProps} />);
    const hostSelect = screen.getByDisplayValue("% (any host)");
    expect(hostSelect).toBeDefined();
  });

  it("shows custom host input when 'Custom…' is selected", () => {
    render(<CreateUserDialog {...mockProps} />);
    fireEvent.change(screen.getByDisplayValue("% (any host)"), {
      target: { value: "__custom__" },
    });
    expect(screen.getByPlaceholderText("hostname or IP")).toBeDefined();
  });

  it("renders password inputs", () => {
    render(<CreateUserDialog {...mockProps} />);
    // The username uses type="text" and there are password inputs
    const textInputs = document.querySelectorAll("input[type=\"text\"]");
    const passwordInputs = document.querySelectorAll("input[type=\"password\"]");
    expect(textInputs.length + passwordInputs.length).toBeGreaterThanOrEqual(2);
  });

  it("shows password mismatch error", () => {
    render(<CreateUserDialog {...mockProps} />);
    const passwordInputs = document.querySelectorAll("input[type=\"password\"]") as NodeListOf<HTMLInputElement>;
    if (passwordInputs.length >= 2) {
      fireEvent.change(passwordInputs[0], { target: { value: "pass1" } });
      fireEvent.change(passwordInputs[1], { target: { value: "pass2" } });
      expect(screen.getByText("Passwords do not match")).toBeDefined();
    }
  });

  it("shows SQL preview when Preview SQL is clicked", () => {
    render(<CreateUserDialog {...mockProps} />);
    const usernameInput = screen.getByPlaceholderText("e.g. app_user");
    fireEvent.change(usernameInput, { target: { value: "testuser" } });
    fireEvent.click(screen.getByText("Preview SQL"));
    expect(screen.getByText(/CREATE USER/)).toBeDefined();
  });

  it("disables Create User button when form is invalid", () => {
    render(<CreateUserDialog {...mockProps} />);
    const buttons = screen.getAllByText("Create User");
    const btn = buttons[buttons.length - 1];
    expect(btn.closest("button")?.disabled).toBe(true);
  });

  it("enables Create User when all required fields are filled", () => {
    render(<CreateUserDialog {...mockProps} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. app_user"), {
      target: { value: "newuser" },
    });
    const passwordInputs = document.querySelectorAll("input[type=\"password\"]") as NodeListOf<HTMLInputElement>;
    if (passwordInputs.length >= 2) {
      fireEvent.change(passwordInputs[0], { target: { value: "pass123" } });
      fireEvent.change(passwordInputs[1], { target: { value: "pass123" } });
    }
    const buttons = screen.getAllByText("Create User");
    const btn = buttons[buttons.length - 1];
    expect(btn.closest("button")?.disabled).toBe(false);
  });

  it("calls executeQuery with CREATE USER SQL on submit", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue([]);

    render(<CreateUserDialog {...mockProps} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. app_user"), {
      target: { value: "newuser" },
    });
    const passwordInputs = document.querySelectorAll("input[type=\"password\"]") as NodeListOf<HTMLInputElement>;
    if (passwordInputs.length >= 2) {
      fireEvent.change(passwordInputs[0], { target: { value: "pass123" } });
      fireEvent.change(passwordInputs[1], { target: { value: "pass123" } });
    }

    const buttons = screen.getAllByText("Create User");
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });

    expect(api.executeQuery).toHaveBeenCalledWith(
      "conn-1",
      expect.stringContaining("CREATE USER 'newuser'"),
      // runStatement passes the database through, so there is a third
      // argument now — undefined for the admin paths (#586).
      undefined,
    );
    expect(mockProps.onCreated).toHaveBeenCalled();
    expect(mockProps.onClose).toHaveBeenCalled();
  });

  it("shows error on creation failure", async () => {
    vi.mocked(api.executeQuery).mockRejectedValue("User already exists");

    render(<CreateUserDialog {...mockProps} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. app_user"), {
      target: { value: "existing" },
    });
    const passwordInputs = document.querySelectorAll("input[type=\"password\"]") as NodeListOf<HTMLInputElement>;
    if (passwordInputs.length >= 2) {
      fireEvent.change(passwordInputs[0], { target: { value: "pass123" } });
      fireEvent.change(passwordInputs[1], { target: { value: "pass123" } });
    }

    const buttons = screen.getAllByText("Create User");
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });

    expect(await screen.findByText("User already exists")).toBeDefined();
  });

  it("includes max connections in SQL when provided", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue([]);

    render(<CreateUserDialog {...mockProps} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. app_user"), {
      target: { value: "newuser" },
    });
    const passwordInputs = document.querySelectorAll("input[type=\"password\"]") as NodeListOf<HTMLInputElement>;
    if (passwordInputs.length >= 2) {
      fireEvent.change(passwordInputs[0], { target: { value: "pass123" } });
      fireEvent.change(passwordInputs[1], { target: { value: "pass123" } });
    }
    fireEvent.change(screen.getByPlaceholderText("Unlimited"), {
      target: { value: "10" },
    });

    const buttons = screen.getAllByText("Create User");
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });

    expect(api.executeQuery).toHaveBeenCalledWith(
      "conn-1",
      expect.stringContaining("MAX_USER_CONNECTIONS 10"),
      // runStatement passes the database through, so there is a third
      // argument now — undefined for the admin paths (#586).
      undefined,
    );
  });

  it("includes ACCOUNT LOCK when checkbox is checked", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue([]);

    render(<CreateUserDialog {...mockProps} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. app_user"), {
      target: { value: "newuser" },
    });
    const passwordInputs = document.querySelectorAll("input[type=\"password\"]") as NodeListOf<HTMLInputElement>;
    if (passwordInputs.length >= 2) {
      fireEvent.change(passwordInputs[0], { target: { value: "pass123" } });
      fireEvent.change(passwordInputs[1], { target: { value: "pass123" } });
    }
    const checkbox = document.querySelector("input[type=\"checkbox\"]") as HTMLInputElement;
    if (checkbox) fireEvent.click(checkbox);

    const buttons = screen.getAllByText("Create User");
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });

    expect(api.executeQuery).toHaveBeenCalledWith(
      "conn-1",
      expect.stringContaining("ACCOUNT LOCK"),
      // runStatement passes the database through, so there is a third
      // argument now — undefined for the admin paths (#586).
      undefined,
    );
  });

  it("closes on Cancel click", () => {
    render(<CreateUserDialog {...mockProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(mockProps.onClose).toHaveBeenCalled();
  });
  /** Fill the form enough to be valid and press Create. */
  async function submit() {
    vi.mocked(api.executeQuery).mockResolvedValue([]);
    render(<CreateUserDialog {...mockProps} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. app_user"), {
      target: { value: "newuser" },
    });
    const passwords = document.querySelectorAll(
      "input[type=\"password\"]",
    ) as NodeListOf<HTMLInputElement>;
    fireEvent.change(passwords[0], { target: { value: "pass123" } });
    fireEvent.change(passwords[1], { target: { value: "pass123" } });

    const buttons = screen.getAllByText("Create User");
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });
  }

  describe("on a production connection (#456)", () => {
    beforeEach(() => {
      connState.activeConnections = [{ id: "conn-1", profile_id: "p1", name: "prod" }];
      connState.profiles = [{ id: "p1", environment: "production" }];
      useProductionGuardStore.setState({ pending: null, resolve: null });
    });

    afterEach(() => {
      connState.activeConnections = [];
      connState.profiles = [];
    });

    it("asks before running, and runs nothing until answered", async () => {
      await submit();

      await waitFor(() => {
        expect(useProductionGuardStore.getState().pending).not.toBeNull();
      });
      expect(api.executeQuery).not.toHaveBeenCalled();
    });

    it("runs nothing when the user declines", async () => {
      await submit();
      await waitFor(() => expect(useProductionGuardStore.getState().pending).not.toBeNull());

      useProductionGuardStore.getState().answer(false);

      await waitFor(() => expect(useProductionGuardStore.getState().pending).toBeNull());
      expect(api.executeQuery).not.toHaveBeenCalled();
    });

    it("runs once the user confirms", async () => {
      await submit();
      await waitFor(() => expect(useProductionGuardStore.getState().pending).not.toBeNull());

      useProductionGuardStore.getState().answer(true);

      await waitFor(() => expect(api.executeQuery).toHaveBeenCalled());
    });

    it("does not ask on a connection that is not production", async () => {
      connState.profiles = [{ id: "p1", environment: "staging" }];

      await submit();

      await waitFor(() => expect(api.executeQuery).toHaveBeenCalled());
      expect(useProductionGuardStore.getState().pending).toBeNull();
    });
  });
});
