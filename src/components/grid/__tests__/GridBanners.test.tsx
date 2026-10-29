import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FOCUS_ROW_LIMIT_EVENT } from "../../../lib/truncation";
import { GridBanners } from "../GridBanners";

const rowCount = {
  total: null,
  plan: { kind: "none", reason: "not a table" },
  counting: false,
  error: null,
  countExactly: vi.fn(),
} as never;

// #853: the banner pointed to Settings, where the row limit is not.
describe("GridBanners row-limit banner", () => {
  it("offers to change the toolbar's LIMIT, and asks it to take focus", () => {
    const heard = vi.fn();
    window.addEventListener(FOCUS_ROW_LIMIT_EVENT, heard);
    render(<GridBanners rowsShown={1000} truncated truncationReason="row_limit" warnings={[]} rowCount={rowCount} />);

    expect(screen.getByText(/Raise the LIMIT in the toolbar/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change LIMIT" }));

    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener(FOCUS_ROW_LIMIT_EVENT, heard);
  });

  it("does not offer it when memory, not the limit, was the cap", () => {
    render(
      <GridBanners rowsShown={1000} truncated truncationReason="memory_guard" warnings={[]} rowCount={rowCount} />,
    );

    expect(screen.queryByRole("button", { name: "Change LIMIT" })).toBeNull();
  });
});
