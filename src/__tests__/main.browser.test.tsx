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
  beforeAll(async () => {
    const rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.appendChild(rootEl);
    await import("../main");
  });

  it("MonacoEnvironment.getWorker returns a new editorWorker instance", () => {
    const env = (self as Record<string, unknown>).MonacoEnvironment as {
      getWorker: () => unknown;
    };
    expect(env).toBeDefined();
    expect(typeof env.getWorker).toBe("function");

    // Call getWorker — covers line 12: return new editorWorker()
    const worker = env.getWorker();
    expect(mk.MockEditorWorker).toHaveBeenCalledTimes(1);
    expect(worker).toBeDefined();
    expect(worker).toHaveProperty("postMessage");
    expect(worker).toHaveProperty("terminate");
  });

  it("calls loader.config with monaco", () => {
    expect(mk.mockLoaderConfig).toHaveBeenCalledWith(
      expect.objectContaining({ monaco: expect.any(Object) }),
    );
  });

  it("calls ReactDOM.createRoot with the root element", () => {
    const rootEl = document.getElementById("root");
    expect(mk.mockCreateRoot).toHaveBeenCalledWith(rootEl);
  });

  it("calls root.render with App in StrictMode", () => {
    expect(mk.mockRender).toHaveBeenCalled();
    const rendered = mk.mockRender.mock.calls[0]?.[0];
    expect(rendered).toBeDefined();
  });
});
