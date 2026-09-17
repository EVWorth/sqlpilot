import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../Modal";

/**
 * The contract a dialog owes a keyboard.
 *
 * Each of these corresponds to something that was broken across the seventeen
 * dialogs this replaces, so they are written as the behaviour a person would
 * notice rather than as assertions about props.
 */

function Fixture({
  onClose = () => {},
  isOpen = true,
  disabledLast = false,
}: {
  onClose?: () => void;
  isOpen?: boolean;
  disabledLast?: boolean;
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} label="Test dialog">
      <button>first</button>
      <input aria-label="middle" />
      <button disabled={disabledLast}>last</button>
    </Modal>
  );
}

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(<Fixture isOpen={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("announces itself as a modal dialog with a name", () => {
    // Without this a screen reader keeps reading the page behind the dialog,
    // and never says a dialog opened. None of the seventeen did this.
    render(<Fixture />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Test dialog");
  });

  it("prefers an explicit label id when one is given", () => {
    render(
      <Modal isOpen onClose={() => {}} label="ignored" labelledBy="heading-id">
        <h2 id="heading-id">Real heading</h2>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe("heading-id");
    // Both at once would be ambiguous, and aria-labelledby wins anyway.
    expect(dialog.getAttribute("aria-label")).toBeNull();
  });

  it("takes focus when it opens", () => {
    render(<Fixture />);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("focuses a specific control when asked to", () => {
    function WithInitial() {
      const ref = useRef<HTMLInputElement>(null);
      return (
        <Modal isOpen onClose={() => {}} label="Named" initialFocus={ref}>
          <button>first</button>
          <input aria-label="the one that matters" ref={ref} />
        </Modal>
      );
    }
    render(<WithInitial />);
    expect(document.activeElement).toBe(screen.getByLabelText("the one that matters"));
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab from the last control back to the first", () => {
    render(<Fixture />);
    screen.getByText("last").focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    render(<Fixture />);
    screen.getByText("first").focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("last"));
  });

  it("sends Shift+Tab from the panel itself to the last control", () => {
    // Focus starts on the panel, so the first thing a keyboard user might do
    // is Shift+Tab. That has to land inside the dialog, not behind it.
    render(<Fixture />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("last"));
  });

  it("skips a disabled control when wrapping", () => {
    // A disabled submit button is a common last element; cycling onto it puts
    // focus somewhere that looks broken.
    render(<Fixture disabledLast />);
    screen.getByLabelText("middle").focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("keeps Tab inside a dialog with nothing focusable in it", () => {
    render(
      <Modal isOpen onClose={() => {}} label="Empty">
        <p>Nothing to focus here.</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
  });

  it("returns focus to whatever opened it", () => {
    // Otherwise focus is left on a dialog that no longer exists, which drops
    // the keyboard user back at the top of the document.
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          <Modal isOpen={open} onClose={() => setOpen(false)} label="Closes">
            <button onClick={() => setOpen(false)}>done</button>
          </Modal>
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByText("opener");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    fireEvent.click(screen.getByText("done"));
    expect(document.activeElement).toBe(opener);
  });

  it("closes when the backdrop is pressed", () => {
    const onClose = vi.fn();
    const { container } = render(<Fixture onClose={onClose} />);
    fireEvent.mouseDown(container.firstElementChild!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when a press starts inside the panel", () => {
    // A drag that selects text and happens to end over the backdrop should
    // not throw the dialog away.
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("can refuse backdrop clicks entirely", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal isOpen onClose={onClose} label="Careful" closeOnBackdrop={false}>
        <button>keep</button>
      </Modal>,
    );
    fireEvent.mouseDown(container.firstElementChild!);
    expect(onClose).not.toHaveBeenCalled();
  });
});
