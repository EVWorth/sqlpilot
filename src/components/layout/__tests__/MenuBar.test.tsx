import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuBar } from "../MenuBar";

vi.mock("../../../lib/tauri-api", () => ({
  api: {},
}));

describe("MenuBar", () => {
  const dispatchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.addEventListener("menu-action", dispatchSpy as any);
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

  it("has a Tools menu with the actions that exist", () => {
    // The AI Assistant entry went with the embedded assistant (ADR-011).
    render(<MenuBar />);

    fireEvent.click(screen.getByText("Tools"));
    expect(screen.getByText("Format SQL")).toBeInTheDocument();
    expect(screen.queryByText("AI Assistant")).toBeNull();
  });

  it("includes 'Check for Updates…' under the Help menu", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("Help"));
    expect(screen.getByText("Check for Updates…")).toBeInTheDocument();
  });

  it("dispatches 'check-for-updates' menu-action when the entry is clicked", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("Help"));
    fireEvent.click(screen.getByText("Check for Updates…"));
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "check-for-updates" }),
    );
  });

  it("includes a 'Cycle Theme' entry under the Help menu (refs #453)", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("Help"));
    expect(screen.getByText(/Cycle Theme/)).toBeInTheDocument();
  });

  it("dispatches 'cycle-theme' menu-action when the entry is clicked", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("Help"));
    fireEvent.click(screen.getByText(/Cycle Theme/));
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "cycle-theme" }),
    );
  });
});
