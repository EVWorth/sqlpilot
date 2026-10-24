import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../../styles/globals.css";
import { useConnectionStore } from "../../../stores/connectionStore";
import { QueryToolbar } from "../QueryToolbar";

vi.mock("../../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/tauri-api")>()),
  api: {},
}));

/**
 * The toolbar at the widths it really gets.
 *
 * At a 1024px window, with the sidebar open, "Find", "Replace" and "Format"
 * were drawn on top of each other, and a long connection name wrapped the
 * shortcut hint onto two lines (#838). jsdom has no layout, so only a browser
 * can say whether two buttons overlap.
 */
function renderAt(width: number) {
  useConnectionStore.setState({
    activeConnections: [{
      id: "c1",
      profile_id: "p1",
      name: "Production (read-only)",
      host: "db.internal.example",
      port: 3306,
      database: null,
      server_version: "8.0.36",
      connected_at: "2026-01-01T00:00:00Z",
      color: null,
      environment: null,
    }],
    selectedConnectionId: "c1",
    profiles: [],
  });
  return render(
    <div style={{ width }}>
      <QueryToolbar />
    </div>,
  );
}

function boxes() {
  return ["Find (Ctrl+F)", "Replace (Ctrl+H)", "Format SQL (Ctrl+Shift+F)", "Refresh Schema Cache"].map((name) =>
    screen.getByRole("button", { name }).getBoundingClientRect()
  );
}

describe("QueryToolbar (browser)", () => {
  it.each([600, 800, 880, 940, 1100])("keeps its buttons apart and on one line at %ipx", (width) => {
    const { container } = renderAt(width);
    const bar = container.firstElementChild?.firstElementChild as HTMLElement;
    const rects = boxes();
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i].left).toBeGreaterThanOrEqual(rects[i - 1].right - 0.5);
    }
    for (const rect of rects) expect(rect.height).toBeLessThanOrEqual(32);
    // Nothing pushed past the end of the bar.
    expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth + 1);
  });

  it("shows labels when there is room and icons when there is not", () => {
    const wide = renderAt(1100);
    expect(screen.getByText("Format")).toBeVisible();
    wide.unmount();
    renderAt(600);
    expect(screen.getByText("Format")).not.toBeVisible();
  });
});
