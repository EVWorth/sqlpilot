import { create } from "zustand";
import type { EditorTab } from "../types";

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;

  addTab: (connectionId?: string, database?: string) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
  setTabConnection: (
    id: string,
    connectionId: string,
    database?: string,
  ) => void;
}

let tabCounter = 0;

export const useEditorStore = create<EditorState>((set) => ({
  tabs: [],
  activeTabId: null,

  addTab: (connectionId, database) => {
    tabCounter++;
    const id = `tab-${tabCounter}`;
    const tab: EditorTab = {
      id,
      title: `Query ${tabCounter}`,
      content: "",
      connectionId,
      database,
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
    return id;
  },

  closeTab: (id) => {
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== id);
      const newActiveId =
        state.activeTabId === id
          ? newTabs.length > 0
            ? newTabs[newTabs.length - 1].id
            : null
          : state.activeTabId;
      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTabContent: (id, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, content, isDirty: true } : t,
      ),
    }));
  },

  setTabConnection: (id, connectionId, database) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, connectionId, database } : t,
      ),
    }));
  },
}));
