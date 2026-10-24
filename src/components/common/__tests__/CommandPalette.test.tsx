import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "../../../stores/connectionStore";
import { CommandPalette } from "../CommandPalette";

/**
 * The palette is controlled by AppLayout, which owns the open state so that
 * View → Command Palette can route to it. The host here stands in for that,
 * and keeps every test below written the way a person uses the thing.
 */
function Host() {
  const [open, setOpen] = useState(false);
  return <CommandPalette isOpen={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} />;
}

/** Every action the app runs arrives as this event, whoever asked for it. */
function listenForActions() {
  const seen: string[] = [];
  window.addEventListener("menu-action", (event) => seen.push((event as CustomEvent<string>).detail));
  return seen;
}

/** Open the palette the way a person does. */
function openPalette() {
  fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
}

function type(text: string) {
  fireEvent.change(screen.getByLabelText("Command"), { target: { value: text } });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stays out of the way until asked for", () => {
    render(<Host />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on Ctrl+Shift+P", () => {
    render(<Host />);
    openPalette();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("opens on plain Ctrl+P too", () => {
    // Both chords, because muscle memory differs by editor and getting it
    // wrong means the feature may as well not exist.
    render(<Host />);
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("puts the cursor in the search field", () => {
    // Anything else means typing the command name goes nowhere, which is the
    // only thing anyone does next.
    render(<Host />);
    openPalette();
    expect(document.activeElement).toBe(screen.getByLabelText("Command"));
  });

  it("lists every command before anything is typed", () => {
    render(<Host />);
    openPalette();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(20);
  });

  it("narrows as you type", () => {
    render(<Host />);
    openPalette();
    type("backup");
    const options = screen.getAllByRole("option");
    expect(options.length).toBeLessThan(5);
    expect(options[0].textContent).toContain("Backup Database");
  });

  it("runs the highlighted command on Enter", async () => {
    // Awaited because the palette runs the action on a microtask, after it has
    // closed and handed focus back — several of these commands open dialogs of
    // their own, and they should arrive to a settled page.
    const actions = listenForActions();
    render(<Host />);
    openPalette();
    type("about");
    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "Enter" });
    await waitFor(() => expect(actions).toContain("about"));
  });

  it("closes once a command is chosen", async () => {
    render(<Host />);
    openPalette();
    type("about");
    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("moves the highlight with the arrow keys", () => {
    render(<Host />);
    openPalette();
    const first = screen.getAllByRole("option")[0];
    expect(first.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });

  it("wraps around rather than stopping at the ends", () => {
    render(<Host />);
    openPalette();
    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "ArrowUp" });
    // The last command that can run: with nothing connected, the ones that
    // need a connection sit below it, greyed (#821).
    const runnable = screen.getAllByRole("option").filter((o) => !o.hasAttribute("aria-disabled"));
    expect(runnable[runnable.length - 1].getAttribute("aria-selected")).toBe("true");
  });

  it("runs a command when it is clicked", async () => {
    const actions = listenForActions();
    render(<Host />);
    openPalette();
    type("about");
    fireEvent.click(screen.getAllByRole("option")[0]);
    await waitFor(() => expect(actions).toContain("about"));
  });

  it("says so when nothing matches, rather than showing an empty box", () => {
    render(<Host />);
    openPalette();
    type("zzzzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/No command matches/)).toBeTruthy();
  });

  it("does nothing on Enter when nothing matches", async () => {
    const actions = listenForActions();
    render(<Host />);
    openPalette();
    type("zzzzzz");
    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "Enter" });
    await Promise.resolve();
    expect(actions).toHaveLength(0);
  });

  it("closes on Escape without running anything", () => {
    const actions = listenForActions();
    render(<Host />);
    openPalette();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions).toHaveLength(0);
  });

  it("forgets the previous query when reopened", () => {
    // Reopening onto last time's filter is a small thing that makes the
    // palette feel like it is arguing with you.
    render(<Host />);
    openPalette();
    type("backup");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    openPalette();
    expect((screen.getByLabelText("Command") as HTMLInputElement).value).toBe("");
  });

  it("shows the shortcut for commands that have one", () => {
    // The palette should make itself less necessary over time.
    render(<Host />);
    openPalette();
    type("new query");
    expect(screen.getAllByRole("option")[0].textContent).toContain("Ctrl+T");
  });
});

describe("saved profiles in the palette (#817)", () => {
  const staging = {
    id: "p-stg",
    name: "Staging",
    host: "stg",
    port: 3306,
    username: "app",
    pool_min: 1,
    pool_max: 5,
    read_only: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as never;

  beforeEach(() => {
    useConnectionStore.setState({ profiles: [staging], activeConnections: [] });
  });

  it("lists \"Connect: <name>\" first for \"conn\" and runs it", async () => {
    const seen = listenForActions();
    render(<Host />);
    openPalette();
    type("conn");

    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Connect: Staging");
    fireEvent.click(options[0]);
    await waitFor(() => expect(seen).toContain("connect:p-stg"));
  });

  it("lists Disconnect last and unrunnable when nothing is connected (#821)", async () => {
    const seen = listenForActions();
    render(<Host />);
    openPalette();
    type("conn");
    const options = screen.getAllByRole("option");
    const disconnect = screen.getByRole("option", { name: /Disconnect/ });
    expect(options.at(-1)).toBe(disconnect);
    expect(disconnect).toHaveAttribute("aria-disabled", "true");
    expect(disconnect).toHaveTextContent("Connect first");

    fireEvent.click(disconnect);
    await Promise.resolve();
    expect(seen).not.toContain("disconnect");
  });

  it("never highlights a command that cannot run (#821)", async () => {
    const seen = listenForActions();
    render(<Host />);
    openPalette();
    type("admin tools");
    // The only match needs a connection, so Enter has nothing to run.
    expect(screen.getByRole("option", { name: /Admin Tools/ })).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "Enter" });
    await Promise.resolve();
    expect(seen).not.toContain("admin-tools");
  });

  it("runs a connection command once a connection is selected (#821)", async () => {
    useConnectionStore.setState({
      activeConnections: [{ id: "c1", profile_id: "p-stg" }] as never,
      selectedConnectionId: "c1",
    });
    const seen = listenForActions();
    render(<Host />);
    openPalette();
    type("admin tools");
    expect(screen.getByRole("option", { name: /Admin Tools/ })).not.toHaveAttribute("aria-disabled");
    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "Enter" });
    await waitFor(() => expect(seen).toContain("admin-tools"));
    useConnectionStore.setState({ activeConnections: [], selectedConnectionId: null });
  });

  it("drops a profile that is already open", () => {
    useConnectionStore.setState({
      activeConnections: [{ id: "c1", profile_id: "p-stg" }] as never,
    });
    render(<Host />);
    openPalette();
    type("staging");
    expect(screen.queryByText("Connect: Staging")).toBeNull();
    useConnectionStore.setState({ activeConnections: [] });
  });

  it("drops a profile that is still connecting", () => {
    useConnectionStore.setState({ connecting: ["p-stg"] });
    render(<Host />);
    openPalette();
    type("staging");
    expect(screen.queryByText("Connect: Staging")).toBeNull();
    useConnectionStore.setState({ connecting: [] });
  });
});
