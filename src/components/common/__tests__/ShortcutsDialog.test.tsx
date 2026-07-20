import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(screen.getByText("Run statement at cursor")).toBeInTheDocument();
    expect(screen.getByText("Run all statements")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Enter / F9")).toBeInTheDocument();
    expect(screen.getByText("Explain Analyze")).toBeInTheDocument();
    expect(screen.getByText("Refresh schema")).toBeInTheDocument();
    expect(screen.getByText("Toggle sidebar")).toBeInTheDocument();
  });

  it("renders all shortcut categories", () => {
    render(<HelpDialog isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("Editor")).toBeInTheDocument();
    expect(screen.getByText("Navigation")).toBeInTheDocument();
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("lists Monaco-default shortcuts that were previously undocumented", () => {
    render(<HelpDialog isOpen={true} onClose={vi.fn()} />);

    // Monaco built-ins that SQLPilot already provides; now documented in the dialog
    expect(screen.getByText("Toggle line comment")).toBeInTheDocument();
    expect(screen.getByText("Toggle block comment")).toBeInTheDocument();
    expect(screen.getByText("Duplicate line / selection")).toBeInTheDocument();
    expect(screen.getByText("Move line up / down")).toBeInTheDocument();
    expect(screen.getByText("Go to definition")).toBeInTheDocument();
    expect(screen.getByText("Lowercase selected keywords")).toBeInTheDocument();
    expect(screen.getByText("Uppercase selected keywords")).toBeInTheDocument();
  });

  it("lists industry-standard navigation shortcuts", () => {
    render(<HelpDialog isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("Switch to tab by index")).toBeInTheDocument();
    expect(screen.getByText("Focus schema tree filter")).toBeInTheDocument();
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

    expect(screen.getByText("Run statement at cursor")).toBeInTheDocument();
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    render(<HelpDialog isOpen={true} onClose={onClose} />);

    const buttons = screen.getAllByRole("button");
    // The X button is near the top
    const xButton = buttons.find((btn) =>
      btn.querySelector("svg") !== null
      && !btn.textContent?.includes("Keyboard")
      && !btn.textContent?.includes("About")
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
