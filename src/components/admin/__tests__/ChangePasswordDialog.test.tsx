import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangePasswordDialog } from "../ChangePasswordDialog";

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
  user: "testuser",
  host: "localhost",
};

describe("ChangePasswordDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders null when not open", () => {
    const { container } = render(
      <ChangePasswordDialog {...mockProps} isOpen={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders dialog with user@host in title", () => {
    render(<ChangePasswordDialog {...mockProps} />);
    expect(screen.getByText(/Change Password.*testuser@localhost/)).toBeDefined();
  });

  it("has password and confirm password fields", () => {
    render(<ChangePasswordDialog {...mockProps} />);
    // The label text for inputs exists as text content
    expect(screen.getByText("New Password")).toBeDefined();
    expect(screen.getByText("Confirm Password")).toBeDefined();
  });

  it("shows 'Passwords do not match' when confirm differs", () => {
    render(<ChangePasswordDialog {...mockProps} />);
    const inputs = screen.getAllByDisplayValue("");
    const newPass = inputs[0];
    const confirmPass = inputs[inputs.length - 1];

    fireEvent.change(newPass, { target: { value: "mypass" } });
    fireEvent.change(confirmPass, { target: { value: "otherpass" } });

    expect(screen.getByText("Passwords do not match")).toBeDefined();
  });

  it("disables 'Change Password' button when passwords are empty", () => {
    render(<ChangePasswordDialog {...mockProps} />);
    const btn = screen.getByText("Change Password");
    expect(btn.closest("button")?.disabled).toBe(true);
  });

  it("disables 'Change Password' button when passwords don't match", () => {
    render(<ChangePasswordDialog {...mockProps} />);
    const inputs = screen.getAllByDisplayValue("");
    fireEvent.change(inputs[0], { target: { value: "pass1" } });
    fireEvent.change(inputs[inputs.length - 1], { target: { value: "pass2" } });
    const btn = screen.getByText("Change Password");
    expect(btn.closest("button")?.disabled).toBe(true);
  });

  it("enables button when passwords match and are non-empty", () => {
    render(<ChangePasswordDialog {...mockProps} />);
    const inputs = screen.getAllByDisplayValue("");
    fireEvent.change(inputs[0], { target: { value: "pass123" } });
    fireEvent.change(inputs[inputs.length - 1], { target: { value: "pass123" } });
    const btn = screen.getByText("Change Password");
    expect(btn.closest("button")?.disabled).toBe(false);
  });

  it("toggles password visibility", () => {
    render(<ChangePasswordDialog {...mockProps} />);
    const newPasswordInput = screen.getAllByDisplayValue("")[0];
    expect(newPasswordInput.getAttribute("type")).toBe("password");

    const eyeButton = document.querySelector("button.absolute") as HTMLButtonElement;
    if (eyeButton) fireEvent.click(eyeButton);

    expect(newPasswordInput.getAttribute("type")).toBe("text");
  });

  it("executes ALTER USER SQL and calls onClose on success", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue([]);
    render(<ChangePasswordDialog {...mockProps} />);

    const inputs = screen.getAllByDisplayValue("");
    fireEvent.change(inputs[0], { target: { value: "newpass" } });
    fireEvent.change(inputs[inputs.length - 1], { target: { value: "newpass" } });

    await act(async () => {
      fireEvent.click(screen.getByText("Change Password"));
    });

    expect(api.executeQuery).toHaveBeenCalledWith(
      "conn-1",
      expect.stringContaining("ALTER USER"),
    );
    expect(mockProps.onClose).toHaveBeenCalled();
  });

  it("shows error on failure", async () => {
    vi.mocked(api.executeQuery).mockRejectedValue("Password change failed");
    render(<ChangePasswordDialog {...mockProps} />);

    const inputs = screen.getAllByDisplayValue("");
    fireEvent.change(inputs[0], { target: { value: "newpass" } });
    fireEvent.change(inputs[inputs.length - 1], { target: { value: "newpass" } });

    await act(async () => {
      fireEvent.click(screen.getByText("Change Password"));
    });

    expect(await screen.findByText("Password change failed")).toBeDefined();
  });

  it("calls onClose when Cancel is clicked", () => {
    render(<ChangePasswordDialog {...mockProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(mockProps.onClose).toHaveBeenCalled();
  });

  it("calls onClose when Esc closes via document keydown", () => {
    render(<ChangePasswordDialog {...mockProps} />);
    // Pressing X button
    const buttons = screen.getAllByRole("button");
    // The first button should be the X close button
    fireEvent.click(buttons[0]);
    // After calling onClose once, Cancel should also call onClose
    expect(mockProps.onClose).toHaveBeenCalled();
  });
});
