import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CellViewerModal } from "../CellViewerModal";

/**
 * The cell viewer has to have somewhere to draw the cell.
 *
 * It renders its content through Monaco, which is absolutely positioned inside
 * whatever box it is given and contributes no intrinsic height of its own. So
 * if the box is zero-tall the modal still looks entirely correct — title,
 * character count, search field, buttons — and shows nothing at all. That is
 * the bug in #217, which was fixed once at a nested wrapper and came back,
 * because the cause was never the wrapper.
 *
 * This is a browser test rather than a jsdom one because it is a question
 * about layout, and jsdom has none. It is only meaningful at all because the
 * suite loads the app's stylesheet (#716) — before that every element in here
 * measured zero and this test would have "passed" against nothing.
 */

/** A value long enough that nobody would mistake an empty box for the truth. */
const LONG_DDL = Array.from(
  { length: 400 },
  (_, i) => `  \`column_${i}\` VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'column number ${i}',`,
).join("\n");

describe("CellViewerModal (browser)", () => {
  it("gives the content area real height to draw into", async () => {
    render(
      <CellViewerModal
        isOpen
        columnName="Create Table"
        content={`CREATE TABLE \`orders\` (\n${LONG_DDL}\n)`}
        dataType="LONGTEXT"
        onClose={vi.fn()}
      />,
    );

    // The header proves the value arrived, which is exactly what made the bug
    // confusing: the count was right and the box was empty.
    expect(screen.getByText(/characters/)).toBeTruthy();

    // The container rather than Monaco itself: Monaco loads asynchronously and
    // may never mount in a test harness, but the box it would be given is
    // already decided by CSS, and that box is where the bug lives.
    const area = screen.getByTestId("cell-viewer-content");
    const box = area.getBoundingClientRect();
    expect(
      box.height,
      `the content area has ${Math.round(box.height)}px to draw 15,000 characters into`,
    ).toBeGreaterThan(120);
  });

  it("stays within the viewport for a very long value", () => {
    // The other half of the same sizing question: given a definite height, it
    // must not grow past the screen and put its own buttons out of reach.
    render(
      <CellViewerModal
        isOpen
        columnName="Create Table"
        content={`CREATE TABLE \`orders\` (\n${LONG_DDL}\n)`}
        dataType="LONGTEXT"
        onClose={vi.fn()}
      />,
    );

    const panel = document.querySelector<HTMLElement>(".w-\\[780px\\]");
    expect(panel, "the panel was not found").toBeTruthy();
    expect(panel!.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight);
  });
});
