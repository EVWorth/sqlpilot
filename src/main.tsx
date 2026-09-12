import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { loader } from "@monaco-editor/react";
// Not the `monaco-editor` barrel.
//
// That barrel is `editor.main`, which pulls in the TypeScript, CSS, HTML and
// JSON *language services* — and Vite then builds and ships their workers:
// 10.8 MB of them, in a SQL client that never edits any of those languages.
// `editor.all` is every editor feature with none of those services, and the
// two contributions below are the only languages this app has.
import "monaco-editor/esm/vs/editor/editor.all.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/mysql/mysql.contribution.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(self as typeof globalThis & { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
