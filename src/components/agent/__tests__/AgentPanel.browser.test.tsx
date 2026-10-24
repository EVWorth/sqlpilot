import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    listHarnesses: vi.fn(),
    agentEndpointStatus: vi.fn(),
    listAgentConnections: vi.fn(),
  },
}));

vi.mock("../../../lib/tauri-api", () => ({ api: apiMocks }));

import { useAgentSessionStore } from "../../../stores/agentSessionStore";
import { AgentPanel } from "../AgentPanel";

/**
 * The panel's width in a real layout, in the 1024px window the fixed 380px
 * did not fit (#822). jsdom has no layout, so only a browser can say how much
 * room the editor beside it is left with.
 */

function Layout() {
  return (
    <div style={{ display: "flex", width: "100vw", height: "600px" }}>
      <div data-testid="editor" style={{ flex: "1 1 0%", minWidth: 0 }} />
      <AgentPanel onClose={() => {}} />
    </div>
  );
}

beforeEach(async () => {
  localStorage.clear();
  await page.viewport(1024, 680);
  apiMocks.listHarnesses.mockResolvedValue([]);
  apiMocks.agentEndpointStatus.mockResolvedValue({ running: false, url: null, token: null });
  apiMocks.listAgentConnections.mockResolvedValue([]);
  useAgentSessionStore.setState({ harnesses: [], session: null, transcript: [], starting: null });
});

afterEach(async () => {
  await page.viewport(1280, 800);
});

const width = (el: Element) => el.getBoundingClientRect().width;

describe("AgentPanel (browser)", () => {
  it("leaves the editor most of a 1024px window", () => {
    render(<Layout />);
    const divider = screen.getByRole("separator", { name: "Resize the agent panel" });
    const panel = divider.parentElement as HTMLElement;
    expect(width(panel)).toBeGreaterThanOrEqual(300);
    expect(width(panel)).toBeLessThan(380);
    expect(width(screen.getByTestId("editor"))).toBeGreaterThan(700);
  });

  it("is resized by dragging its divider", async () => {
    render(<Layout />);
    const divider = screen.getByRole("separator", { name: "Resize the agent panel" });
    const panel = divider.parentElement as HTMLElement;
    const before = width(panel);
    const box = divider.getBoundingClientRect();
    const y = box.top + 50;
    const x = box.left + box.width / 2;
    divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
    divider.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: x - 120, clientY: y, pointerId: 1 }),
    );
    divider.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x - 120, clientY: y, pointerId: 1 }));
    await expect.poll(() => width(panel)).toBeCloseTo(before + 120, 0);
  });

  it("is resized from the keyboard", async () => {
    render(<Layout />);
    const divider = screen.getByRole("separator", { name: "Resize the agent panel" });
    const before = width(divider.parentElement as HTMLElement);
    divider.focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => width(divider.parentElement as HTMLElement)).toBeCloseTo(before + 16, 0);
  });
});
