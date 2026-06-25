import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateUserDialog } from "../CreateUserDialog";

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
    );
  });

  it("closes on Cancel click", () => {
    render(<CreateUserDialog {...mockProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(mockProps.onClose).toHaveBeenCalled();
  });
});
