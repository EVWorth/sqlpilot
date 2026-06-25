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
  beforeAll(async () => {
    const rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.appendChild(rootEl);
    await import("../main");
  });

  it("calls createRoot with the root element", () => {
    const rootEl = document.getElementById("root");
    expect(mockCreateRoot).toHaveBeenCalledWith(rootEl);
  });

  it("calls render with StrictMode and App", () => {
    expect(mockRender).toHaveBeenCalled();
    const rendered = mockRender.mock.calls[0]?.[0];
    expect(rendered).toBeDefined();
  });

  it("configures the Monaco loader", () => {
    expect(mockLoaderConfig).toHaveBeenCalledWith(
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
