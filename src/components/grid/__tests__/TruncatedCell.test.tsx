import { act, fireEvent, render, screen } from "@testing-library/react";
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

describe("binary cells (#401)", () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01];

  it("says what the value is instead of listing its bytes", () => {
    // `String(bytes)` printed 137,80,78,71,13,10,26,10,… — every byte,
    // comma-separated. That is not a preview of a PNG.
    render(<TruncatedCell value={PNG} columnName="avatar" dataType="mediumblob" onViewFull={() => {}} />);

    expect(screen.getByText("[image/png, 10 B]")).toBeInTheDocument();
    expect(screen.queryByText(/137,80/)).not.toBeInTheDocument();
  });

  it("says only the size when it cannot name the type", () => {
    render(<TruncatedCell value={[0, 1, 2]} columnName="data" dataType="blob" onViewFull={() => {}} />);
    expect(screen.getByText("[BLOB, 3 B]")).toBeInTheDocument();
  });

  it("always offers the viewer, since the cell itself shows nothing useful", () => {
    render(<TruncatedCell value={PNG} columnName="avatar" dataType="blob" onViewFull={() => {}} />);
    expect(screen.getByLabelText("View full content")).toBeInTheDocument();
  });

  it("hands the viewer the bytes rather than their text form", () => {
    const onViewFull = vi.fn();
    render(<TruncatedCell value={PNG} columnName="avatar" dataType="blob" onViewFull={onViewFull} />);

    fireEvent.click(screen.getByLabelText("View full content"));

    expect(onViewFull).toHaveBeenCalledWith(null, "avatar", PNG);
  });
});

describe("TruncatedCell copy (#739)", () => {
  function stubClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  }
  const getCopyButton = (container: HTMLElement) => container.querySelector("button[aria-label=\"Copy value\"]");

  it("copies a long value as stored, without opening the viewer", async () => {
    const writeText = stubClipboard();
    const onViewFull = vi.fn();
    const ddl = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB";
    const { container } = render(
      <TruncatedCell value={ddl} columnName="Create Table" dataType="text" onViewFull={onViewFull} />,
    );
    const copy = getCopyButton(container);
    expect(copy).not.toBeNull();
    await act(async () => {
      fireEvent.click(copy!);
    });
    expect(writeText).toHaveBeenCalledWith(ddl);
    expect(onViewFull).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("copies bytes as hex, the same as the viewer", async () => {
    const writeText = stubClipboard();
    const { container } = render(
      <TruncatedCell value={[0x89, 0x50, 0x0a]} columnName="data" onViewFull={vi.fn()} />,
    );
    await act(async () => {
      fireEvent.click(getCopyButton(container)!);
    });
    expect(writeText).toHaveBeenCalledWith("89500a");
  });

  it("is offered only where the expand button is", () => {
    const { container } = render(
      <TruncatedCell value="short" columnName="col" dataType="varchar" onViewFull={vi.fn()} />,
    );
    expect(getCopyButton(container)).toBeNull();
    expect(getIconButton(container)).toBeNull();
  });

  it("copying does not also click the row", async () => {
    stubClipboard();
    const onRowClick = vi.fn();
    const { container } = render(
      <div onClick={onRowClick}>
        <TruncatedCell value={"x".repeat(40)} columnName="col" dataType="text" onViewFull={vi.fn()} />
      </div>,
    );
    await act(async () => {
      fireEvent.click(getCopyButton(container)!);
    });
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

// A row source may paint only the start of a long value (its `full_len` says
// how long it really is). What is painted must never be taken for the value.
describe("a value that was cut short", () => {
  function stubClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  }
  const whole = "the start, and then the rest of it";

  /** A promise the test settles, to see what happens before it does. */
  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("shows the start, marked as not being all of it, and always offers the viewer", () => {
    const { container } = render(
      <TruncatedCell
        value="the start"
        columnName="note"
        dataType="varchar"
        fullLen={34}
        loadFull={async () => whole}
        onViewFull={vi.fn()}
      />,
    );
    expect(screen.getByText("the start…")).toBeInTheDocument();
    // A short varchar gets no icon; a cut one always does.
    expect(getIconButton(container)).not.toBeNull();
  });

  it("says a BLOB's real size, not the size of the part it holds", () => {
    render(
      <TruncatedCell
        value={[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]}
        columnName="avatar"
        dataType="blob"
        fullLen={2 * 1024 * 1024}
        loadFull={async () => []}
        onViewFull={vi.fn()}
      />,
    );
    expect(screen.getByText("[image/png, 2.0 MB]")).toBeInTheDocument();
  });

  it("fetches the whole value before the viewer shows it", async () => {
    const onViewFull = vi.fn();
    const full = deferred<unknown>();
    const loadFull = vi.fn(() => full.promise);
    const { container } = render(
      <TruncatedCell
        value="the start"
        columnName="note"
        dataType="text"
        fullLen={34}
        loadFull={loadFull}
        onViewFull={onViewFull}
      />,
    );

    fireEvent.click(getIconButton(container) as HTMLButtonElement);
    expect(loadFull).toHaveBeenCalledTimes(1);
    // Nothing is shown while the whole value is on its way: not the part.
    await act(async () => {});
    expect(onViewFull).not.toHaveBeenCalled();

    await act(async () => full.resolve(whole));
    expect(onViewFull).toHaveBeenCalledWith(whole, "note");
  });

  it("hands the viewer the whole of a BLOB", async () => {
    const onViewFull = vi.fn();
    const bytes = [1, 2, 3, 4, 5, 6];
    render(
      <TruncatedCell
        value={[1, 2]}
        columnName="data"
        dataType="blob"
        fullLen={6}
        loadFull={async () => bytes}
        onViewFull={onViewFull}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("View full content"));
    });
    expect(onViewFull).toHaveBeenCalledWith(null, "data", bytes);
  });

  it("copies the whole value, not the part painted", async () => {
    const writeText = stubClipboard();
    const full = deferred<unknown>();
    const { container } = render(
      <TruncatedCell
        value="the start"
        columnName="note"
        dataType="text"
        fullLen={34}
        loadFull={() => full.promise}
        onViewFull={vi.fn()}
      />,
    );

    fireEvent.click(container.querySelector("button[aria-label=\"Copy value\"]") as HTMLButtonElement);
    await act(async () => {});
    expect(writeText).not.toHaveBeenCalled();

    await act(async () => full.resolve(whole));
    expect(writeText).toHaveBeenCalledWith(whole);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("copies the whole of a BLOB as hex", async () => {
    const writeText = stubClipboard();
    const { container } = render(
      <TruncatedCell
        value={[0x89]}
        columnName="data"
        fullLen={3}
        loadFull={async () => [0x89, 0x50, 0x0a]}
        onViewFull={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(container.querySelector("button[aria-label=\"Copy value\"]") as HTMLButtonElement);
    });
    expect(writeText).toHaveBeenCalledWith("89500a");
  });

  it("opens nothing and copies nothing when the whole value cannot be had", async () => {
    const writeText = stubClipboard();
    const onViewFull = vi.fn();
    const { container } = render(
      <TruncatedCell
        value="the start"
        columnName="note"
        dataType="text"
        fullLen={34}
        loadFull={() => Promise.reject(new Error("gone"))}
        onViewFull={onViewFull}
      />,
    );
    await act(async () => {
      fireEvent.click(getIconButton(container) as HTMLButtonElement);
      fireEvent.click(container.querySelector("button[aria-label=\"Copy value\"]") as HTMLButtonElement);
    });
    expect(onViewFull).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });

  it("treats a value with no full length as whole, whatever else it is given", () => {
    const onViewFull = vi.fn();
    const loadFull = vi.fn();
    const { container } = render(
      <TruncatedCell
        value={"a".repeat(40)}
        columnName="note"
        dataType="text"
        fullLen={null}
        loadFull={loadFull}
        onViewFull={onViewFull}
      />,
    );
    fireEvent.click(getIconButton(container) as HTMLButtonElement);
    expect(loadFull).not.toHaveBeenCalled();
    expect(onViewFull).toHaveBeenCalledWith("a".repeat(40), "note");
  });
});
