import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAiStore } from "../../../stores/aiStore";
import { MenuBar } from "../MenuBar";

vi.mock("../../../lib/tauri-api", () => ({
  api: {},
}));

describe("MenuBar", () => {
  const dispatchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.addEventListener("menu-action", dispatchSpy as any);

    useAiStore.setState({
      status: { provider: "openai", available: false },
      isStreaming: false,
      conversations: [],
      activeConversationId: null,
      streamSegments: [],
      mode: "ask",
      pendingPermission: null,
      aiEnabled: false,
    } as any);
  });

  afterEach(() => {
    window.removeEventListener("menu-action", dispatchSpy as any);
  });

  it("renders File, Edit, Connection, Database, Tools, Help menu labels", () => {
    render(<MenuBar />);

    expect(screen.getByText("File")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Connection")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Help")).toBeInTheDocument();
  });

  it("shows dropdown menu when a menu label is clicked", () => {
    render(<MenuBar />);

    expect(screen.queryByText("New Query Tab")).toBeNull();

    fireEvent.click(screen.getByText("File"));

    expect(screen.getByText("New Query Tab")).toBeInTheDocument();
    expect(screen.getByText("Import Data…")).toBeInTheDocument();
    expect(screen.getByText("Quit")).toBeInTheDocument();
  });

  it("closes dropdown when clicking the same menu again", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("File"));
    expect(screen.getByText("New Query Tab")).toBeInTheDocument();

    fireEvent.click(screen.getByText("File"));
    expect(screen.queryByText("New Query Tab")).toBeNull();
  });

  it("switches to another menu when a different label is clicked", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("File"));
    expect(screen.getByText("New Query Tab")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Edit"));
    expect(screen.queryByText("New Query Tab")).toBeNull();
    expect(screen.getByText("Undo")).toBeInTheDocument();
  });

  it("dispatches menu-action event when a menu item is clicked", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("File"));
    fireEvent.click(screen.getByText("New Query Tab"));

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "new-query" }),
    );
  });

  it("closes dropdown after item click", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("File"));
    fireEvent.click(screen.getByText("New Query Tab"));

    expect(screen.queryByText("New Query Tab")).toBeNull();
  });

  it("shows keyboard shortcuts on menu items", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("File"));
    expect(screen.getByText("Ctrl+T")).toBeInTheDocument();
  });

  it("closes dropdown on Escape key press", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("File"));
    expect(screen.getByText("New Query Tab")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("New Query Tab")).toBeNull();
  });

  it("closes dropdown on click outside", () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <MenuBar />
      </div>,
    );

    fireEvent.click(screen.getByText("File"));
    expect(screen.getByText("New Query Tab")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByText("New Query Tab")).toBeNull();
  });

  it("includes AI Assistant in Tools menu when AI is enabled", () => {
    useAiStore.setState({
      aiEnabled: true,
    } as any);

    render(<MenuBar />);

    fireEvent.click(screen.getByText("Tools"));
    expect(screen.getByText("AI Assistant")).toBeInTheDocument();
  });

  it("does not include AI Assistant when AI is disabled", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("Tools"));
    expect(screen.queryByText("AI Assistant")).toBeNull();
  });
});
