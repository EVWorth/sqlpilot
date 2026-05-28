import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HelpDialog } from "../ShortcutsDialog";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getAppVersion: vi.fn().mockResolvedValue("1.0.0"),
  },
}));

describe("ShortcutsDialog (HelpDialog)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <HelpDialog isOpen={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the keyboard shortcuts tab by default", () => {
    render(<HelpDialog isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
    expect(screen.getByText("About")).toBeInTheDocument();
    // Check that actual shortcut descriptions appear (Execute query appears twice: Ctrl+Enter and F5)
    const executeTexts = screen.getAllByText("Execute query");
    expect(executeTexts.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Ctrl+Enter")).toBeInTheDocument();
  });

  it("renders all shortcut categories", () => {
    render(<HelpDialog isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("Editor")).toBeInTheDocument();
    expect(screen.getByText("Navigation")).toBeInTheDocument();
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("switches to About tab when clicked", () => {
    render(<HelpDialog isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("About"));
    expect(screen.getByText("SQLPilot")).toBeInTheDocument();
    expect(
      screen.getByText("A blazing-fast, AI-powered MySQL GUI — built with Rust & React."),
    ).toBeInTheDocument();
  });

  it("switches back to Shortcuts tab when clicked", () => {
    render(<HelpDialog isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("About"));
    fireEvent.click(screen.getByText("Keyboard Shortcuts"));

    const executeTexts2 = screen.getAllByText("Execute query");
    expect(executeTexts2.length).toBeGreaterThanOrEqual(1);
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    render(<HelpDialog isOpen={true} onClose={onClose} />);

    const buttons = screen.getAllByRole("button");
    // The X button is near the top
    const xButton = buttons.find((btn) =>
      btn.querySelector("svg") !== null &&
      !btn.textContent?.includes("Keyboard") &&
      !btn.textContent?.includes("About"),
    );
    fireEvent.click(xButton!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows version number in About tab when loaded", async () => {
    render(<HelpDialog isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("About"));

    expect(await screen.findByText("Version 1.0.0")).toBeInTheDocument();
  });

  it("renders Buy me a coffee link in About tab", () => {
    render(<HelpDialog isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("About"));

    expect(screen.getByText(/Buy me a coffee/)).toBeInTheDocument();
  });
});
