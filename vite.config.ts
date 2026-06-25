import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { defineConfig } from "vite";

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
        manualChunks(id: string) {
          if (id.includes("monaco-editor") || id.includes("@monaco-editor/react")) return "monaco";
          if (id.includes("@tanstack/react-table") || id.includes("@tanstack/react-virtual")) return "tanstack";
          if (id.includes("lucide-react")) return "lucide";
        },
        // Generate smaller chunks for better parallelism
        chunkFileNames: "chunks/[name].[hash].js",
        entryFileNames: "[name].[hash].js",
      },
    },
  },
}));
