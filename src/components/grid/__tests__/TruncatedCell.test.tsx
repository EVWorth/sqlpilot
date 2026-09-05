import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TruncatedCell } from "../TruncatedCell";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  /** Total ever constructed. `instances` only holds the live ones, since
   * disconnect removes from it — so it cannot show churn on its own. */
  static created = 0;
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.created++;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    FakeResizeObserver.instances = FakeResizeObserver.instances.filter((i) => i !== this);
  }
  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
});

beforeEach(() => {
  FakeResizeObserver.instances = [];
  FakeResizeObserver.created = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function getIconButton(container: HTMLElement) {
  return container.querySelector("button[aria-label=\"View full content\"]");
}

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

  it("renders full long string values (visual truncation handled by CSS, #216)", () => {
    const longText = "a".repeat(100);
    const { container } = render(
      <TruncatedCell value={longText} columnName="col" onViewFull={vi.fn()} />,
    );
    expect(container.textContent).toContain("aaa");
    expect(container.textContent?.length).toBe(longText.length);
  });

  it("applies truncate class to the text element", () => {
    const { container } = render(
      <TruncatedCell value="any value" columnName="col" onViewFull={vi.fn()} />,
    );
    const text = container.querySelector(".truncate");
    expect(text).not.toBeNull();
  });

  it("does not show icon for short non-text values", () => {
    const { container } = render(
      <TruncatedCell value="hi" columnName="col" onViewFull={vi.fn()} />,
    );
    expect(getIconButton(container)).toBeNull();
  });

  it("does not show icon for short numeric values", () => {
    const { container } = render(
      <TruncatedCell value={42} columnName="col" onViewFull={vi.fn()} />,
    );
    expect(getIconButton(container)).toBeNull();
  });

  it("does not show icon for null values", () => {
    const { container } = render(
      <TruncatedCell value={null} columnName="col" onViewFull={vi.fn()} />,
    );
    expect(getIconButton(container)).toBeNull();
  });

  it("does not show icon for text types with below-threshold values", () => {
    const { container } = render(
      <TruncatedCell
        value={"x".repeat(15)}
        columnName="col"
        dataType="varchar(255)"
        onViewFull={vi.fn()}
      />,
    );
    expect(getIconButton(container)).toBeNull();
  });

  it("shows icon for text/blob/json types with non-trivial values", () => {
    const longText = "a".repeat(100);
    for (const dataType of ["text", "TEXT", "tinytext", "mediumtext", "longtext", "blob", "BLOB", "json", "JSON"]) {
      const { container, unmount } = render(
        <TruncatedCell
          value={longText}
          columnName="col"
          dataType={dataType}
          onViewFull={vi.fn()}
        />,
      );
      expect(getIconButton(container)).not.toBeNull();
      unmount();
    }
  });

  it("shows icon when actual overflow is detected via ResizeObserver (#216)", async () => {
    const onViewFull = vi.fn();
    const { container } = render(
      <TruncatedCell
        value={"a".repeat(50)}
        columnName="col"
        dataType="varchar(50)"
        onViewFull={onViewFull}
      />,
    );
    expect(getIconButton(container)).toBeNull();

    const textEl = container.querySelector(".truncate") as HTMLElement;
    Object.defineProperty(textEl, "scrollWidth", { configurable: true, value: 500 });
    Object.defineProperty(textEl, "clientWidth", { configurable: true, value: 100 });
    await act(async () => {
      FakeResizeObserver.instances[0]?.trigger();
    });

    expect(getIconButton(container)).not.toBeNull();
  });

  it("hides icon when overflow ceases after column widens", async () => {
    const { container } = render(
      <TruncatedCell
        value={"a".repeat(50)}
        columnName="col"
        dataType="varchar(50)"
        onViewFull={vi.fn()}
      />,
    );
    const textEl = container.querySelector(".truncate") as HTMLElement;

    Object.defineProperty(textEl, "scrollWidth", { configurable: true, value: 500 });
    Object.defineProperty(textEl, "clientWidth", { configurable: true, value: 100 });
    await act(async () => {
      FakeResizeObserver.instances[0]?.trigger();
    });
    expect(getIconButton(container)).not.toBeNull();

    Object.defineProperty(textEl, "scrollWidth", { configurable: true, value: 50 });
    Object.defineProperty(textEl, "clientWidth", { configurable: true, value: 100 });
    await act(async () => {
      FakeResizeObserver.instances[0]?.trigger();
    });
    expect(getIconButton(container)).toBeNull();
  });

  it("icon click opens the viewer", () => {
    const onViewFull = vi.fn();
    const longText = "a".repeat(100);
    const { container } = render(
      <TruncatedCell
        value={longText}
        columnName="payload"
        dataType="text"
        onViewFull={onViewFull}
      />,
    );
    const button = getIconButton(container) as HTMLButtonElement;
    fireEvent.click(button);
    expect(onViewFull).toHaveBeenCalledWith(longText, "payload");
  });

  it("icon click stops propagation so row selection is not triggered", () => {
    const onViewFull = vi.fn();
    const parentClick = vi.fn();
    const longText = "a".repeat(100);
    const { container } = render(
      <div onClick={parentClick}>
        <TruncatedCell
          value={longText}
          columnName="payload"
          dataType="text"
          onViewFull={onViewFull}
        />
      </div>,
    );
    const button = getIconButton(container) as HTMLButtonElement;
    fireEvent.click(button);
    expect(onViewFull).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("double-clicking the text also opens the viewer when icon is shown", () => {
    const onViewFull = vi.fn();
    const longText = "a".repeat(100);
    const { container } = render(
      <TruncatedCell
        value={longText}
        columnName="payload"
        dataType="text"
        onViewFull={onViewFull}
      />,
    );
    const textEl = container.querySelector(".truncate") as HTMLElement;
    fireEvent.doubleClick(textEl);
    expect(onViewFull).toHaveBeenCalledWith(longText, "payload");
  });

  it("double-click does not open the viewer when no icon is shown", () => {
    const onViewFull = vi.fn();
    const { container } = render(
      <TruncatedCell value="short" columnName="col" onViewFull={onViewFull} />,
    );
    const textEl = container.querySelector(".truncate") as HTMLElement;
    fireEvent.doubleClick(textEl);
    expect(onViewFull).not.toHaveBeenCalled();
  });
});

describe("observer churn", () => {
  it("keeps one observer across value changes", () => {
    // The effect listed `formatted` as a dependency, so every new value tore
    // the observer down and built another. A grid polling SELECT NOW(), or a
    // column being typed into, does that for every visible cell on every
    // render (#417).
    const { rerender } = render(
      <TruncatedCell value="12:00:00" columnName="now" onViewFull={() => {}} />,
    );
    expect(FakeResizeObserver.created).toBe(1);

    for (let i = 1; i <= 25; i++) {
      rerender(
        <TruncatedCell value={`12:00:${String(i).padStart(2, "0")}`} columnName="now" onViewFull={() => {}} />,
      );
    }

    expect(FakeResizeObserver.created).toBe(1);
    expect(FakeResizeObserver.instances).toHaveLength(1);
  });

  it("keeps one observer when only the column metadata changes", () => {
    // Neither of these has any bearing on whether text overflows its box,
    // and both were dependencies.
    const { rerender } = render(
      <TruncatedCell value="x" columnName="a" dataType="varchar" onViewFull={() => {}} />,
    );
    rerender(<TruncatedCell value="x" columnName="b" dataType="text" onViewFull={() => {}} />);

    expect(FakeResizeObserver.created).toBe(1);
  });

  it("still disconnects when the cell unmounts", () => {
    const { unmount } = render(
      <TruncatedCell value="x" columnName="a" onViewFull={() => {}} />,
    );
    expect(FakeResizeObserver.instances).toHaveLength(1);
    unmount();
    expect(FakeResizeObserver.instances).toHaveLength(0);
  });
});
