import { create } from "zustand";
import type { FileHead } from "../lib/bindings";
import { api } from "../lib/tauri-api";

/** A native file dialog's filters: a label and the extensions under it. */
export type FileFilters = [string, string[]][];

/**
 * Native file dialogs and whole-file reads and writes (#862).
 *
 * Components used to call these on the API directly. They hold no state:
 * what a pick or a write means — a backup target, an export, a dump to
 * preview — belongs to the store or component that asked, and so does how a
 * failure is shown. Each action resolves or rejects exactly as the API does.
 */
interface FileState {
  /** The chosen path, or null when the dialog was cancelled. */
  pickFile: (title: string, filters: FileFilters) => Promise<string | null>;
  /** The chosen path, or null when the dialog was cancelled. */
  pickSaveFile: (title: string, defaultName: string, filters: FileFilters) => Promise<string | null>;
  readFileContents: (path: string) => Promise<string>;
  writeFileContents: (path: string, contents: string) => Promise<void>;
  /** The first `maxBytes` of a file, without holding the rest in the renderer. */
  readFileHead: (path: string, maxBytes: number) => Promise<FileHead>;
}

export const useFileStore = create<FileState>(() => ({
  pickFile: (title, filters) => api.pickFile(title, filters),
  pickSaveFile: (title, defaultName, filters) => api.pickSaveFile(title, defaultName, filters),
  readFileContents: (path) => api.readFileContents(path),
  writeFileContents: async (path, contents) => {
    await api.writeFileContents(path, contents);
  },
  readFileHead: (path, maxBytes) => api.readFileHead(path, maxBytes),
}));
