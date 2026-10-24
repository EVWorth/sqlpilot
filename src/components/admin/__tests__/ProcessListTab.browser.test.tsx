import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getProcessList: vi.fn(),
    getOwnThreadIds: vi.fn(),
    killProcess: vi.fn(),
    killQuery: vi.fn(),
  },
}));

import { api } from "../../../lib/tauri-api";
import { ProcessListTab } from "../ProcessListTab";

const processes = [
  {
    id: 1,
    user: "analytics",
    host: "10.0.0.5:51234",
    db: "analytics",
    command: "Query",
    time: 340,
    state: "Sending data",
    info: "SELECT customer_id, SUM(total) FROM orders GROUP BY customer_id",
  },
  { id: 2214, user: "app", host: "10.0.0.7:40112", db: "shop", command: "Sleep", time: 47, state: null, info: null },
];

describe("ProcessListTab (browser)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getProcessList).mockResolvedValue(processes);
    vi.mocked(api.getOwnThreadIds).mockResolvedValue([]);
  });

  it("opens the kill confirm without reflowing the table (#833)", async () => {
    render(
      <div style={{ width: 1000, height: 400 }}>
        <ProcessListTab connectionId="c1" />
      </div>,
    );
    await screen.findByTitle("Kill process 2214");
    const headers = () =>
      Array.from(document.querySelectorAll("thead th")).map((th) => th.getBoundingClientRect().width);
    const before = headers();

    fireEvent.click(screen.getByTitle("Kill process 1"));
    expect(screen.getByText("Kill query")).toBeVisible();

    expect(headers()).toEqual(before);
  });
});
