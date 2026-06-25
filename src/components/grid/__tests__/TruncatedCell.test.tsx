import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TruncatedCell } from "../TruncatedCell";

describe("TruncatedCell", () => {
  it("renders NULL for null value", () => {
    const { container } = render(
      <TruncatedCell value={null} columnName="col" onViewFull={vi.fn()} />,
    );
    expect(container.textContent).toBe("NULL");
  });

  it("renders NULL for undefined value", () => {
    const { container } = render(
      <TruncatedCell value={undefined} columnName="col" onViewFull={vi.fn()} />,
    );
    expect(container.textContent).toBe("NULL");
  });

  it("renders short string value", () => {
    const { container } = render(
      <TruncatedCell value="hello" columnName="col" onViewFull={vi.fn()} />,
    );
    expect(container.textContent).toBe("hello");
  });

  it("renders boolean true as string", () => {
    const { container } = render(
      <TruncatedCell value={true} columnName="col" onViewFull={vi.fn()} />,
    );
    expect(container.textContent).toBe("true");
  });

  it("renders boolean false as string", () => {
    const { container } = render(
      <TruncatedCell value={false} columnName="col" onViewFull={vi.fn()} />,
    );
    expect(container.textContent).toBe("false");
  });

  it("renders number values", () => {
    const { container } = render(
      <TruncatedCell value={42} columnName="col" onViewFull={vi.fn()} />,
    );
    expect(container.textContent).toBe("42");
  });

  it("truncates long string values", () => {
    const longText = "a".repeat(100);
    const { container } = render(
      <TruncatedCell value={longText} columnName="col" onViewFull={vi.fn()} />,
    );
    const text = container.textContent ?? "";
    expect(text.length).toBeLessThan(100);
    expect(text.endsWith("...")).toBe(true);
  });

  it("does not truncate short string values", () => {
    const shortText = "a".repeat(30);
    const { container } = render(
      <TruncatedCell value={shortText} columnName="col" onViewFull={vi.fn()} />,
    );
    expect(container.textContent).toBe(shortText);
  });

  it("calls onViewFull on double click when truncated", () => {
    const onViewFull = vi.fn();
    const longText = "a".repeat(100);
    render(
      <TruncatedCell value={longText} columnName="myCol" onViewFull={onViewFull} />,
    );

    const cell = screen.getByText((content) => content.endsWith("..."));
    fireEvent.doubleClick(cell);
    expect(onViewFull).toHaveBeenCalledWith(longText, "myCol");
  });

  it("does not call onViewFull on double click when not truncated", () => {
    const onViewFull = vi.fn();
    render(
      <TruncatedCell value="short" columnName="col" onViewFull={onViewFull} />,
    );

    fireEvent.doubleClick(screen.getByText("short"));
    expect(onViewFull).not.toHaveBeenCalled();
  });

  it("null values do not trigger onViewFull on double click (not truncated)", () => {
    const onViewFull = vi.fn();
    render(
      <TruncatedCell value={null} columnName="col" onViewFull={onViewFull} />,
    );

    fireEvent.doubleClick(screen.getByText("NULL"));
    expect(onViewFull).not.toHaveBeenCalled();
  });

  it("shows hover title when truncated", () => {
    const longText = "a".repeat(100);
    render(
      <TruncatedCell value={longText} columnName="col" onViewFull={vi.fn()} />,
    );
    expect(screen.getByTitle("Double-click to view full content")).toBeInTheDocument();
  });

  it("has no hover title when not truncated", () => {
    render(
      <TruncatedCell value="short" columnName="col" onViewFull={vi.fn()} />,
    );
    expect(
      screen.queryByTitle("Double-click to view full content"),
    ).not.toBeInTheDocument();
  });
});
