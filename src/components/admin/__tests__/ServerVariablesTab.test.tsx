import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerVariable } from "../../../types";
import { ServerVariablesTab } from "../ServerVariablesTab";

vi.mock("../../../lib/tauri-api", () => ({
  api: { getServerVariables: vi.fn() },
}));

// The dialog runs SET through the query path; here only its onChanged
// callback matters, so a stub button stands in for a successful Apply.
vi.mock("../SetVariableDialog", () => ({
  SetVariableDialog: (
    { variable, onChanged, onClose }: {
      variable: ServerVariable | null;
      onChanged: (name: string) => void;
      onClose: () => void;
    },
  ) =>
    variable
      ? (
        <button
          onClick={() => {
            onChanged(variable.name);
            onClose();
          }}
        >
          stub-apply
        </button>
      )
      : null,
}));

import { api } from "../../../lib/tauri-api";

const variables: ServerVariable[] = [
  { name: "max_connections", value: "151" },
  { name: "innodb_buffer_pool_size", value: "134217728" },
  { name: "innodb_log_buffer_size", value: "16777216" },
  { name: "version", value: "8.0.35" },
];

describe("ServerVariablesTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getServerVariables).mockResolvedValue(variables);
  });

  it("shows the spinner on the first load", () => {
    vi.mocked(api.getServerVariables).mockReturnValue(new Promise(() => {}));
    render(<ServerVariablesTab connectionId="c1" />);
    expect(screen.getByText("Loading variables…")).toBeDefined();
  });

  it("keeps the table on screen while it reloads after SET (#819)", async () => {
    render(<ServerVariablesTab connectionId="c1" />);
    await screen.findByText("max_connections");

    let resolveReload: (v: ServerVariable[]) => void = () => {};
    vi.mocked(api.getServerVariables).mockReturnValue(
      new Promise((r) => {
        resolveReload = r;
      }),
    );
    fireEvent.click(screen.getByTitle("Change max_connections"));
    fireEvent.click(screen.getByText("stub-apply"));

    // Reload in flight: the table must not be swapped for the spinner,
    // or the user's scroll position is lost.
    expect(api.getServerVariables).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Loading variables…")).toBeNull();
    expect(screen.getByRole("table")).toBeDefined();

    await act(async () => {
      resolveReload(variables.map((v) => v.name === "max_connections" ? { ...v, value: "300" } : v));
    });
    expect(screen.getByText("300")).toBeDefined();
    const row = screen.getByText("max_connections").closest("tr");
    expect(row?.getAttribute("data-updated")).toBe("true");
  });

  it("clears the highlight after a moment", async () => {
    vi.useFakeTimers();
    try {
      render(<ServerVariablesTab connectionId="c1" />);
      await act(async () => {});
      fireEvent.click(screen.getByTitle("Change max_connections"));
      fireEvent.click(screen.getByText("stub-apply"));
      await act(async () => {});
      const row = () => screen.getByText("max_connections").closest("tr");
      expect(row()?.getAttribute("data-updated")).toBe("true");
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(row()?.getAttribute("data-updated")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ServerVariablesTab filter and keyboard (#824)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getServerVariables).mockResolvedValue(variables);
  });

  it("counts the filtered variables against the total", async () => {
    render(<ServerVariablesTab connectionId="c1" />);
    await screen.findByText("max_connections");
    expect(screen.getByText("4 variables")).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("Filter variables…"), { target: { value: "buffer" } });
    expect(screen.getByText("2 of 4 variables")).toBeDefined();
  });

  it("says so when nothing matches the filter", async () => {
    render(<ServerVariablesTab connectionId="c1" />);
    await screen.findByText("max_connections");
    fireEvent.change(screen.getByPlaceholderText("Filter variables…"), { target: { value: "zzzz" } });
    expect(screen.getByText(/No variables match/)).toBeDefined();
    expect(screen.getByText("0 of 4 variables")).toBeDefined();
  });

  it("sorts from a real button and reports the order with aria-sort", async () => {
    render(<ServerVariablesTab connectionId="c1" />);
    await screen.findByText("max_connections");
    const nameHeader = screen.getByRole("columnheader", { name: /Variable Name/ });
    const valueHeader = screen.getByRole("columnheader", { name: /Value/ });
    expect(nameHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(valueHeader.getAttribute("aria-sort")).toBe("none");

    fireEvent.click(screen.getByRole("button", { name: /Variable Name/ }));
    expect(nameHeader.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(screen.getByRole("button", { name: /^Value/ }));
    expect(valueHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(nameHeader.getAttribute("aria-sort")).toBe("none");
  });

  it("collapses a group from a button with aria-expanded", async () => {
    render(<ServerVariablesTab connectionId="c1" />);
    await screen.findByText("innodb_buffer_pool_size");
    const toggle = screen.getByRole("button", { name: /^innodb\s*\(2\)$/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("innodb_buffer_pool_size")).toBeNull();
  });
});
