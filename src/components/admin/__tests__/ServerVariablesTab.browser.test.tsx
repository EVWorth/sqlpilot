import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../styles/globals.css";

vi.mock("../../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/tauri-api")>()),
  api: { getServerVariables: vi.fn() },
}));

import { api } from "../../../lib/tauri-api";
import { ServerVariablesTab } from "../ServerVariablesTab";

const opacity = (el: Element) => getComputedStyle(el).opacity;

/** Tab forward until `target` has focus, as a keyboard user would. */
async function tabTo(user: ReturnType<typeof userEvent.setup>, target: Element) {
  for (let i = 0; i < 40 && document.activeElement !== target; i++) await user.tab();
  expect(document.activeElement).toBe(target);
}

describe("ServerVariablesTab (browser)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getServerVariables).mockResolvedValue([{ name: "max_connections", value: "151" }]);
  });

  // Tabbing onto the pencil used to land on a button drawn at opacity 0 (#784).
  it("shows the edit pencil when it has keyboard focus", async () => {
    const user = userEvent.setup();
    render(<ServerVariablesTab connectionId="c1" />);
    const pencil = await screen.findByTitle("Change max_connections");
    expect(opacity(pencil)).toBe("0");

    await tabTo(user, pencil);
    expect(opacity(pencil)).toBe("1");
  });

  it("shows the copy icon while its button has keyboard focus", async () => {
    const user = userEvent.setup();
    render(<ServerVariablesTab connectionId="c1" />);
    const copyName = (await screen.findByText("max_connections")).closest("button");
    const icon = copyName?.querySelector("svg");
    if (!copyName || !icon) throw new Error("copy button not rendered");
    expect(opacity(icon)).toBe("0");

    await tabTo(user, copyName);
    expect(opacity(icon)).toBe("1");
  });
});
