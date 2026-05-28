import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallBlock } from "../ToolCallBlock";
import type { ToolExecution } from "../../../types";

const makeTool = (overrides: Partial<ToolExecution> = {}): ToolExecution => ({
  id: "tool-1",
  name: "list_tables",
  status: "running",
  arguments: { database: "testdb" },
  result: undefined,
  ...overrides,
});

describe("ToolCallBlock", () => {
  it("renders the tool label with a friendly name", () => {
    const tool = makeTool({ name: "list_tables", status: "running" });
    render(<ToolCallBlock tool={tool} />);
    expect(screen.getByText(/Listing tables/)).toBeInTheDocument();
  });

  it("falls back to raw tool name when no label mapping exists", () => {
    const tool = makeTool({ name: "unknown_tool", status: "running", arguments: {} });
    render(<ToolCallBlock tool={tool} />);
    expect(screen.getByText(/unknown_tool/)).toBeInTheDocument();
  });

  it("shows the running spinner when status is running", () => {
    const tool = makeTool({ name: "list_tables", status: "running" });
    const { container } = render(<ToolCallBlock tool={tool} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("shows the checkmark when status is done", () => {
    const tool = makeTool({ name: "list_tables", status: "done" });
    const { container } = render(<ToolCallBlock tool={tool} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("shows the X icon when status is error", () => {
    const tool = makeTool({ name: "list_tables", status: "error" });
    const { container } = render(<ToolCallBlock tool={tool} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("shows the command summary for list_databases", () => {
    const tool = makeTool({ name: "list_databases", status: "done", arguments: {} });
    render(<ToolCallBlock tool={tool} />);
    expect(screen.getByText(/SHOW DATABASES/)).toBeInTheDocument();
  });

  it("shows the command summary for list_tables with database arg", () => {
    const tool = makeTool({
      name: "list_tables",
      status: "done",
      arguments: { database: "mydb" },
    });
    render(<ToolCallBlock tool={tool} />);
    expect(screen.getByText(/SHOW TABLES FROM `mydb`/)).toBeInTheDocument();
  });

  it("shows the command summary for run_select_query with sql arg", () => {
    const tool = makeTool({
      name: "run_select_query",
      status: "done",
      arguments: { sql: "SELECT * FROM users" },
    });
    render(<ToolCallBlock tool={tool} />);
    expect(screen.getByText(/SELECT \* FROM users/)).toBeInTheDocument();
  });

  it("shows truncated command when longer than 80 chars", () => {
    const longSql = "SELECT " + "a, ".repeat(50) + "b FROM t";
    const tool = makeTool({
      name: "run_query",
      status: "done",
      arguments: { sql: longSql },
    });
    render(<ToolCallBlock tool={tool} />);

    const codeEl = screen.getByText((content) => content.includes("SELECT"));
    expect(codeEl.textContent).toContain("…");
  });

  it("expands to show details when clicked", () => {
    const tool = makeTool({
      name: "run_query",
      status: "done",
      arguments: { sql: "SELECT 1" },
      result: "1 row(s) affected",
    });
    render(<ToolCallBlock tool={tool} />);

    expect(screen.queryByText("Result")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText("1 row(s) affected")).toBeInTheDocument();
  });

  it("collapses when clicked again", () => {
    const tool = makeTool({
      name: "run_query",
      status: "done",
      arguments: { sql: "SELECT 1" },
      result: "1 row(s)",
    });
    render(<ToolCallBlock tool={tool} />);

    const toggleBtn = screen.getByRole("button");
    fireEvent.click(toggleBtn);
    expect(screen.getByText("Result")).toBeInTheDocument();

    fireEvent.click(toggleBtn);
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
  });

  it("does not show expand chevron when there are no details", () => {
    const tool = makeTool({
      name: "unknown_tool",
      status: "done",
      arguments: {},
      result: undefined,
    });
    const { container } = render(<ToolCallBlock tool={tool} />);
    expect(container.querySelector(".lucide-chevron-right")).toBeNull();
    expect(container.querySelector(".lucide-chevron-down")).toBeNull();
  });

  it("hides connection_id from command summary in arguments", () => {
    const tool = makeTool({
      name: "run_select_query",
      status: "done",
      arguments: { sql: "SELECT 1", connection_id: "hidden-id" },
    });
    render(<ToolCallBlock tool={tool} />);
    const codeEl = screen.getByText((content) => content.includes("SELECT 1"));
    expect(codeEl.textContent).toBe("SELECT 1");
  });
});
