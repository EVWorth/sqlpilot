import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GridPlaceholder } from "../GridPlaceholder";

describe("GridPlaceholder", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // #850: a cancel the user asked for is not a failure.
  it("shows a cancel neutrally, with how long the query ran", () => {
    render(
      <GridPlaceholder isExecuting={false} error={null} result={undefined} cancelledAfterMs={1234} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Cancelled after 1.2 s");
    expect(screen.queryByText("Query Error")).not.toBeInTheDocument();
  });

  it("still reports a real error as an error", () => {
    render(<GridPlaceholder isExecuting={false} error="boom" result={undefined} />);

    expect(screen.getByText("Query Error")).toBeInTheDocument();
  });

  it("counts the elapsed time while a query runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    render(<GridPlaceholder isExecuting error={null} result={undefined} startedAt={5_000} />);
    expect(screen.getByText("0.0 s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(screen.getByText("2.0 s")).toBeInTheDocument();
  });
});

// #845: the box said only "Query Error", not which statement of the script.
describe("GridPlaceholder failed statement", () => {
  it("names the statement, its position and its code, and shows its text", () => {
    render(
      <GridPlaceholder
        isExecuting={false}
        error="Table 'shop.nope' doesn't exist"
        result={undefined}
        failedStatement={{ index: 1, count: 3, sql: "SELECT * FROM nope", code: 1146 }}
      />,
    );

    expect(screen.getByText("Statement 2 of 3 failed (1146)")).toBeInTheDocument();
    expect(screen.getByText("SELECT * FROM nope")).toBeInTheDocument();
  });
});
