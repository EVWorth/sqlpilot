import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    type("backup");
    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "Enter" });
    await waitFor(() => expect(actions).toContain("backup"));
  });

  it("closes once a command is chosen", async () => {
    render(<Host />);
    openPalette();
    type("backup");
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
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1].getAttribute("aria-selected")).toBe("true");
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
