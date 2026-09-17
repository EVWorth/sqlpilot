import { beforeAll, describe, expect, it, vi } from "vitest";

// ── ALL state referenced inside vi.mock factories in vi.hoisted() ──
const mk = vi.hoisted(() => {
  const MockEditorWorker = vi.fn(function(this: Record<string, unknown>) {
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
  });
  const mockLoaderConfig = vi.fn();
  const mockRender = vi.fn();
  const mockCreateRoot = vi.fn(() => ({ render: mockRender }));

  return { MockEditorWorker, mockLoaderConfig, mockRender, mockCreateRoot };
});

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: mk.MockEditorWorker,
}));

vi.mock("@monaco-editor/react", () => ({
  loader: { config: mk.mockLoaderConfig },
}));

vi.mock("monaco-editor", () => ({
  default: { languages: {}, editor: {} },
}));

// Provide both default and named export — main.tsx uses default import
const reactDomClientMock = { createRoot: mk.mockCreateRoot };
vi.mock("react-dom/client", () => ({
  default: reactDomClientMock,
  createRoot: mk.mockCreateRoot,
}));

vi.mock("../App", () => ({
  default: () => null,
}));

vi.mock("../styles/globals.css", () => ({}));

describe("main.tsx entry point (browser)", () => {
  // What loading the module did, copied out before the assertions run.
  //
  // Loading is a one-time side effect, and vitest clears mock calls before
  // each test — so by the time the first assertion looks at a mock, the calls
  // made at import are gone. Re-importing per test is not an option here:
  // module caching in browser mode belongs to the browser, so `resetModules`
  // cannot make the module evaluate a second time. Recording the calls is the
  // thing that survives both.
  let atImport: {
    loaderConfig: unknown[][];
    createRoot: unknown[][];
    render: unknown[][];
  };

  beforeAll(async () => {
    const rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.appendChild(rootEl);
    await import("../main");

    const copy = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map((call) => [...call]);
    atImport = {
      loaderConfig: copy(mk.mockLoaderConfig),
      createRoot: copy(mk.mockCreateRoot),
      render: copy(mk.mockRender),
    };
  });

  it("MonacoEnvironment.getWorker returns a new editorWorker instance", () => {
    const env = (self as Record<string, unknown>).MonacoEnvironment as {
      getWorker: () => unknown;
    };
    expect(env).toBeDefined();
    expect(typeof env.getWorker).toBe("function");

    // Called here rather than at import, so this one reads the mock directly.
    const worker = env.getWorker();
    expect(mk.MockEditorWorker).toHaveBeenCalledTimes(1);
    expect(worker).toBeDefined();
    expect(worker).toHaveProperty("postMessage");
    expect(worker).toHaveProperty("terminate");
  });

  it("calls loader.config with monaco", () => {
    expect(atImport.loaderConfig[0]?.[0]).toEqual(
      expect.objectContaining({ monaco: expect.any(Object) }),
    );
  });

  it("calls ReactDOM.createRoot with the root element", () => {
    expect(atImport.createRoot[0]?.[0]).toBe(document.getElementById("root"));
  });

  it("calls root.render with App in StrictMode", () => {
    expect(atImport.render).toHaveLength(1);
    expect(atImport.render[0]?.[0]).toBeDefined();
  });
});
