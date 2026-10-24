import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "../../../stores/connectionStore";
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

  it("includes a 'Cycle Theme' entry under the View menu (refs #453)", () => {
    // Under View rather than Help since the menus were sorted out: cycling the
    // theme changes the view, and Help had become the place things went when
    // no menu obviously owned them.
    render(<MenuBar />);

    fireEvent.click(screen.getByText("View"));
    expect(screen.getByText(/Cycle Theme/)).toBeInTheDocument();
  });

  it("dispatches 'cycle-theme' menu-action when the entry is clicked", () => {
    render(<MenuBar />);

    fireEvent.click(screen.getByText("View"));
    fireEvent.click(screen.getByText(/Cycle Theme/));
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "cycle-theme" }),
    );
  });
});

describe("items that need a connection (#821)", () => {
  afterEach(() => {
    useConnectionStore.setState({ activeConnections: [], selectedConnectionId: null });
  });

  it("greys them out and does not run them while nothing is connected", () => {
    useConnectionStore.setState({ activeConnections: [], selectedConnectionId: null });
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener("menu-action", listener);
    render(<MenuBar />);

    fireEvent.click(screen.getByText("Database"));
    const admin = screen.getByText("Admin Tools").closest("button");
    expect(admin).toHaveAttribute("aria-disabled", "true");
    expect(admin).toHaveAttribute("title", "Connect first");
    fireEvent.click(screen.getByText("Admin Tools"));
    expect(seen).toEqual([]);

    fireEvent.click(screen.getByText("File"));
    expect(screen.getByText("Import Data…").closest("button")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Backup Database…").closest("button")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("New Query Tab").closest("button")).not.toHaveAttribute("aria-disabled");
    window.removeEventListener("menu-action", listener);
  });

  it("enables them once a connection is selected", () => {
    useConnectionStore.setState({
      activeConnections: [{ id: "c1", profile_id: "p1" }] as never,
      selectedConnectionId: "c1",
    });
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener("menu-action", listener);
    render(<MenuBar />);

    fireEvent.click(screen.getByText("Database"));
    expect(screen.getByText("Admin Tools").closest("button")).not.toHaveAttribute("aria-disabled");
    fireEvent.click(screen.getByText("Admin Tools"));
    expect(seen).toEqual(["admin-tools"]);
    window.removeEventListener("menu-action", listener);
  });
});

describe("Connection → Connect to (#817)", () => {
  const profile = (id: string, name: string) => ({ id, name, host: "h" }) as never;

  it("lists the saved profiles and connects to the one chosen", () => {
    useConnectionStore.setState({
      profiles: [profile("p1", "Local dev"), profile("p2", "Staging")],
      activeConnections: [{ id: "c1", profile_id: "p1" }] as never,
    });
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener("connect-profile", listener);
    render(<MenuBar />);

    fireEvent.click(screen.getByText("Connection"));
    fireEvent.click(screen.getByText("Connect to"));
    // Already connected: shown, not offered.
    expect(screen.getByRole("menuitem", { name: /Local dev/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: /Staging/ }));

    window.removeEventListener("connect-profile", listener);
    expect(seen).toEqual(["p2"]);
    expect(screen.queryByText("Connect to")).toBeNull();
  });

  it("does not offer a profile that is still connecting", () => {
    useConnectionStore.setState({
      profiles: [profile("p1", "Local dev"), profile("p2", "Staging")],
      activeConnections: [],
      connecting: ["p2"],
    });
    render(<MenuBar />);

    fireEvent.click(screen.getByText("Connection"));
    fireEvent.click(screen.getByText("Connect to"));
    expect(screen.getByRole("menuitem", { name: /Staging/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Local dev/ })).toBeEnabled();
    useConnectionStore.setState({ connecting: [] });
  });

  it("says when there is nothing to connect to", () => {
    useConnectionStore.setState({ profiles: [], activeConnections: [] });
    render(<MenuBar />);
    fireEvent.click(screen.getByText("Connection"));
    fireEvent.click(screen.getByText("Connect to"));
    expect(screen.getByText("No saved connections")).toBeInTheDocument();
  });
});
