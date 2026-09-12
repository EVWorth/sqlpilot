import "@testing-library/jest-dom";
import { vi } from "vitest";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

// Polyfill localStorage for jsdom
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// jsdom implements no scrolling at all, so anything that follows a growing
// list — a transcript, a log — throws on a method every browser has.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Monaco's clipboard contribution asks this at import time, and jsdom has no
// implementation — not even a stub that returns false. A real browser has it,
// so this is a jsdom gap rather than anything about the app.
if (typeof document !== "undefined" && !("queryCommandSupported" in document)) {
  Object.defineProperty(document, "queryCommandSupported", {
    writable: true,
    configurable: true,
    value: () => false,
  });
}

// Polyfill matchMedia for jsdom
Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
