import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../../styles/globals.css";
import { ConnectionDialog } from "../ConnectionDialog";

vi.mock("../../../stores/connectionStore", () => ({
  useConnectionStore: vi.fn((selector: (s: unknown) => unknown) => selector({ saveProfile: vi.fn() })),
}));

vi.mock("../../../lib/tauri-api", () => ({ api: { testConnection: vi.fn() } }));

/**
 * The dialog's box, with real layout.
 *
 * Switching tabs changed the body's height, and with the dialog centred that
 * moved its top edge and every button in it (#838).
 */
describe("ConnectionDialog (browser)", () => {
  it("keeps the same top and height on every tab", () => {
    render(<ConnectionDialog isOpen onClose={() => {}} />);
    const panel = screen.getByRole("dialog");
    const boxes = ["General", "SSL", "SSH Tunnel", "Advanced"].map((name) => {
      fireEvent.click(screen.getByRole("tab", { name }));
      const rect = panel.getBoundingClientRect();
      return { top: Math.round(rect.top), height: Math.round(rect.height) };
    });
    for (const box of boxes) expect(box).toEqual(boxes[0]);
  });
});
