import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { Modal } from "../Modal";

/**
 * The focus trap, against a real keyboard.
 *
 * The jsdom tests next to this one dispatch synthetic `keydown` events, which
 * proves the handler does the right thing when it runs — but a synthetic Tab
 * never moves focus, so they cannot prove the browser agrees about what Tab
 * would have done. Only a real Tab can, and that is the whole point of a trap:
 * the failure mode is focus quietly landing on the page behind the dialog.
 */

function Fixture({ onClose = () => {} }: { onClose?: () => void }) {
  return (
    <>
      <button>behind the dialog</button>
      <Modal isOpen onClose={onClose} label="Trapped">
        <button>first</button>
        <input aria-label="middle" />
        <button>last</button>
      </Modal>
    </>
  );
}

describe("Modal (browser)", () => {
  it("keeps a real Tab inside the dialog, all the way round", async () => {
    render(<Fixture />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    // One more press than there are stops, so the wrap is exercised.
    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      expect(
        dialog.contains(document.activeElement),
        `focus escaped after ${i + 1} Tab presses, onto ${document.activeElement?.textContent}`,
      ).toBe(true);
    }
  });

  it("keeps a real Shift+Tab inside the dialog", async () => {
    // The direction that used to walk straight out into the page: focus starts
    // on the panel, and backwards from there is the button behind it.
    render(<Fixture />);
    const dialog = screen.getByRole("dialog");

    for (let i = 0; i < 5; i++) {
      await userEvent.tab({ shift: true });
      expect(
        dialog.contains(document.activeElement),
        `focus escaped backwards after ${i + 1} presses`,
      ).toBe(true);
    }
  });

  it("never lands on the control behind the dialog", async () => {
    render(<Fixture />);
    const behind = screen.getByText("behind the dialog");

    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      expect(document.activeElement).not.toBe(behind);
    }
  });

  it("closes on a real Escape key", async () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
