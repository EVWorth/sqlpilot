import react from "@vitejs/plugin-react";
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    plugins: [react()],
    test: {
      name: "jsdom",
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test-setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      exclude: ["src/**/*.browser.{test,spec}.{ts,tsx}"],
      coverage: {
        reporter: ["text", "json", "html"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/**/*.{test,spec,spec.browser,test.browser}.{ts,tsx}", "src/test-setup.ts"],
      },
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
  },
  {
    plugins: [react()],
    test: {
      name: "browser",
      globals: true,
      environment: "browser",
      setupFiles: ["./src/test-setup.ts"],
      include: ["src/**/*.browser.{test,spec}.{ts,tsx}"],
      coverage: {
        reporter: ["text", "json", "html"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/**/*.{test,spec,spec.browser,test.browser}.{ts,tsx}", "src/test-setup.ts"],
      },
      browser: {
        enabled: true,
        name: "chromium",
        provider: "playwright",
        headless: true,
      },
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
  },
]);
