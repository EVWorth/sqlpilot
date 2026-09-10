import { create } from "zustand";

/**
 * Which app-level dialog is open, and what it was opened for.
 *
 * These lived as seven `useState` pairs in AppLayout, which meant every route
 * that wanted to open one — the menu dispatcher, the sidebar's context menus,
 * the toolbar — had to reach into that component, and adding a dialog meant
 * editing the layout shell (#450). The backup and restore pre-select state was
 * copy-pasted between the two.
 *
 * One store instead. AppLayout renders the dialogs; anything that wants one
 * open says so from wherever it is.
 */

/** What a dialog was opened against, when it was opened from a context menu. */
export interface DialogTarget {
  connectionId?: string;
  database?: string;
}

export type AppDialog = "import" | "backup" | "restore" | "help";

interface DialogState {
  /** The dialog currently open, or null. Only one at a time. */
  open: AppDialog | null;
  /** What the open dialog was opened against. Empty when opened from a menu. */
  target: DialogTarget;
  /** Which tab the help dialog shows. */
  helpTab: "shortcuts" | "about";

  openDialog: (dialog: AppDialog, target?: DialogTarget) => void;
  openHelp: (tab: "shortcuts" | "about") => void;
  closeDialog: () => void;
}

export const useDialogStore = create<DialogState>((set) => ({
  open: null,
  target: {},
  helpTab: "shortcuts",

  // The target is replaced, never merged: a dialog opened from the menu must
  // not inherit the connection a previous context-menu open selected.
  openDialog: (dialog, target = {}) => set({ open: dialog, target }),

  openHelp: (tab) => set({ open: "help", helpTab: tab, target: {} }),

  closeDialog: () => set({ open: null, target: {} }),
}));
