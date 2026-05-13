import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    sourcemap: process.env.NODE_ENV === "development",
    minify: "terser",
    terserOptions: {
      compress: {
        drop_console: true,
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          // Split Monaco Editor into its own chunk for better caching
          // Monaco is ~2MB and rarely changes
          monaco: ["monaco-editor", "@monaco-editor/react"],
          // Split TanStack libraries (table virtualization)
          tanstack: ["@tanstack/react-table", "@tanstack/react-virtual"],
          // Split UI libraries
          lucide: ["lucide-react"],
        },
        // Generate smaller chunks for better parallelism
        chunkFileNames: "chunks/[name].[hash].js",
        entryFileNames: "[name].[hash].js",
      },
    },
  },
}));
