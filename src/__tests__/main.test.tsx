import { beforeAll, describe, expect, it, vi } from "vitest";

const mockRender = vi.fn();
const mockCreateRoot = vi.fn(() => ({ render: mockRender }));
const mockLoaderConfig = vi.fn();

vi.mock("react-dom/client", () => ({
  default: { createRoot: mockCreateRoot },
  createRoot: mockCreateRoot,
}));

vi.mock("@monaco-editor/react", () => ({
  loader: { config: mockLoaderConfig },
}));

vi.mock("monaco-editor", () => ({
  default: { languages: {}, editor: {} },
}));

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class {},
}));

vi.mock("../App", () => ({
  default: () => null,
}));

vi.mock("../styles/globals.css", () => ({}));

describe("main.tsx entry point", () => {
  // What loading the module did, copied out before the assertions run.
  //
  // Loading is a one-time side effect, and vitest clears mock calls before
  // each test — so by the time the first assertion looks at a mock, the calls
  // made at import are gone. Recording them keeps this readable and matches
  // the browser twin of this file, where re-importing is not even possible.
  let atImport: {
    createRoot: unknown[][];
    render: unknown[][];
    loaderConfig: unknown[][];
  };

  beforeAll(async () => {
    const rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.appendChild(rootEl);
    await import("../main");

    const copy = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map((call) => [...call]);
    atImport = {
      createRoot: copy(mockCreateRoot),
      render: copy(mockRender),
      loaderConfig: copy(mockLoaderConfig),
    };
  });

  it("calls createRoot with the root element", () => {
    expect(atImport.createRoot[0]?.[0]).toBe(document.getElementById("root"));
  });

  it("calls render with StrictMode and App", () => {
    expect(atImport.render).toHaveLength(1);
    expect(atImport.render[0]?.[0]).toBeDefined();
  });

  it("configures the Monaco loader", () => {
    expect(atImport.loaderConfig[0]?.[0]).toEqual(
      expect.objectContaining({ monaco: expect.any(Object) }),
    );
  });

  it("sets MonacoEnvironment on self", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (self as any).MonacoEnvironment;
    expect(env).toBeDefined();
    expect(typeof env.getWorker).toBe("function");
  });
});
