import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.browser.{test,spec}.{ts,tsx}"],
    coverage: {
      reporter: ["text", "json", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.{test,spec, browser.test,browser.spec}.{ts,tsx}", "src/test-setup.ts"],
    },
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      // A desktop window, because that is what this app is. The default is
      // 414×896 — a phone — which put the title bar's window controls at
      // x=430, off the right edge and beyond anything `elementFromPoint` can
      // reach. Any test measuring where things are needs the viewport to be
      // somewhere they fit.
      viewport: { width: 1280, height: 800 },
      instances: [
        { browser: "chromium" },
      ],
    },
  },
  // Pre-bundle monaco up front, or it is discovered mid-run.
  //
  // Vite's scanner starts from the app entry and does not reach monaco through
  // the test files, so on a cold cache it optimized monaco *during* the run,
  // announced "optimized dependencies changed. reloading", and reloaded the
  // page underneath tests that were already executing. What came out the other
  // side was a hundred failures wearing unrelated costumes — "Failed to fetch
  // dynamically imported module", "Invalid hook call", files collecting zero
  // tests — none of which point at the reload that caused them.
  //
  // Only ever visible on a cold cache, which is why a warm working copy passed
  // and CI, which is always cold, was one scheduling accident from failing.
  optimizeDeps: {
    include: ["monaco-editor"],
  },
  css: {
    postcss: "./postcss.config.js",
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
