import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CellViewerModal } from "../CellViewerModal";

vi.mock("@monaco-editor/react", () => ({
  __esModule: true,
  default: vi.fn(({ className }: { className?: string }) => (
    <div data-testid="monaco-editor" className={className}>
      Monaco Editor
    </div>
  )),
}));

vi.mock("sql-formatter", () => ({
  format: vi.fn((sql: string) => sql),
}));

vi.mock("../../stores/themeStore", () => ({
  useThemeStore: vi.fn((selector: (s: unknown) => unknown) => {
    const state = { effectiveTheme: "dark" };
    return selector(state);
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function createDefaultProps(overrides = {}) {
  return {
    isOpen: true,
    columnName: "my_column",
    content: "hello world",
    dataType: "varchar",
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("CellViewerModal", () => {
  it("returns null when isOpen is false", () => {
    const { container } = render(
      <CellViewerModal
        isOpen={false}
        content="test"
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders modal when isOpen is true", () => {
    const props = createDefaultProps();
    const { container } = render(<CellViewerModal {...props} />);
    expect(container.firstElementChild).toBeInTheDocument();
  });

  it("displays the column name in the header", () => {
    render(<CellViewerModal {...createDefaultProps({ columnName: "user_email" })} />);
    expect(screen.getByText("user_email")).toBeInTheDocument();
  });

  it("displays the data type badge", () => {
    render(<CellViewerModal {...createDefaultProps({ dataType: "varchar" })} />);
    expect(screen.getByText("TEXT")).toBeInTheDocument();
  });

  it("displays JSON type badge for JSON data type", () => {
    render(<CellViewerModal {...createDefaultProps({ dataType: "json" })} />);
    expect(screen.getByText("JSON")).toBeInTheDocument();
  });

  it("displays BLOB type badge for BLOB data type", () => {
    render(<CellViewerModal {...createDefaultProps({ dataType: "blob" })} />);
    expect(screen.getByText("BLOB")).toBeInTheDocument();
  });

  it("shows NULL value display when content is null", () => {
    render(<CellViewerModal {...createDefaultProps({ content: null })} />);
    expect(screen.getByText("NULL value")).toBeInTheDocument();
  });

  it("shows character count for non-null content", () => {
    render(<CellViewerModal {...createDefaultProps({ content: "hello world" })} />);
    expect(screen.getByText("11 characters")).toBeInTheDocument();
  });

  it("renders Copy button", () => {
    render(<CellViewerModal {...createDefaultProps()} />);
    expect(screen.getByText("Copy")).toBeInTheDocument();
  });

  it("renders Download button", () => {
    render(<CellViewerModal {...createDefaultProps()} />);
    expect(screen.getByText("Download")).toBeInTheDocument();
  });

  it("renders Close button", () => {
    render(<CellViewerModal {...createDefaultProps()} />);
    const closeButtons = screen.getAllByText("Close");
    expect(closeButtons.length).toBeGreaterThan(0);
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<CellViewerModal {...createDefaultProps({ onClose })} />);
    const closeButtons = screen.getAllByText("Close");
    fireEvent.click(closeButtons[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    render(<CellViewerModal {...createDefaultProps({ onClose })} />);
    const xButtons = screen.getAllByRole("button");
    // Find the X button - it's the one in the header
    const allButtons = document.querySelectorAll("button");
    let clicked = false;
    allButtons.forEach((btn) => {
      if (btn.querySelector(".lucide-x") && !clicked) {
        fireEvent.click(btn);
        clicked = true;
      }
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders Edit/Read-only toggle button", () => {
    render(<CellViewerModal {...createDefaultProps()} />);
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("disables Edit button when content is null", () => {
    render(<CellViewerModal {...createDefaultProps({ content: null })} />);
    const editBtn = screen.getByText("Edit");
    expect(editBtn).toBeDisabled();
  });

  it("renders Monaco editor for non-null content", () => {
    render(<CellViewerModal {...createDefaultProps({ content: "test" })} />);
    expect(screen.getByTestId("monaco-editor")).toBeInTheDocument();
  });

  it("applies full-size layout classes to Monaco editor wrapper (#217)", () => {
    render(<CellViewerModal {...createDefaultProps({ content: "test" })} />);
    const editor = screen.getByTestId("monaco-editor");
    expect(editor.className).toMatch(/\bh-full\b/);
    expect(editor.className).toMatch(/\bw-full\b/);
    expect(editor.className).toMatch(/\boverflow-hidden\b/);
  });

  it("does not nest Monaco inside an extra overflow-hidden wrapper (#217)", () => {
    const { container } = render(
      <CellViewerModal {...createDefaultProps({ content: "test" })} />,
    );
    const editor = screen.getByTestId("monaco-editor");
    const contentWrapper = container.querySelector(".min-h-0.flex-1.p-4");
    expect(contentWrapper).not.toBeNull();
    expect(contentWrapper?.firstElementChild).toBe(editor);
  });

  it("remounts Monaco editor when content length changes (#217)", async () => {
    const { rerender } = render(
      <CellViewerModal {...createDefaultProps({ content: "short" })} />,
    );
    const { default: MockedEditor } = await import("@monaco-editor/react");
    const firstCalls = (MockedEditor as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.length;
    rerender(
      <CellViewerModal
        {...createDefaultProps({ content: "a much longer content value" })}
      />,
    );
    const secondCalls = (MockedEditor as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.length;
    expect(secondCalls).toBeGreaterThan(firstCalls);
  });

  it("shows search input when content length > 500", () => {
    const longContent = "x".repeat(501);
    render(<CellViewerModal {...createDefaultProps({ content: longContent })} />);
    expect(screen.getByPlaceholderText("Search content...")).toBeInTheDocument();
  });

  it("does not show search input when content is short", () => {
    render(<CellViewerModal {...createDefaultProps({ content: "short" })} />);
    expect(screen.queryByPlaceholderText("Search content...")).not.toBeInTheDocument();
  });

  it("switches to read-only mode when Edit is clicked", () => {
    render(<CellViewerModal {...createDefaultProps({ content: "editable content" })} />);
    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("copies content to clipboard when Copy is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    render(<CellViewerModal {...createDefaultProps({ content: "copy me" })} />);
    fireEvent.click(screen.getByText("Copy"));
    expect(writeText).toHaveBeenCalledWith("copy me");
  });
});
