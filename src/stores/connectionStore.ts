import { create } from "zustand";
import type {
  ConnectionProfile,
  ConnectionProfileSummary,
  ConnectionInfo,
} from "../types";
import { api } from "../lib/tauri-api";

interface ConnectionState {
  profiles: ConnectionProfileSummary[];
  activeConnections: ConnectionInfo[];
  selectedConnectionId: string | null;
  loading: boolean;
  error: string | null;

  loadProfiles: () => Promise<void>;
  saveProfile: (profile: ConnectionProfile) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  connect: (profileId: string) => Promise<ConnectionInfo>;
  disconnect: (connectionId: string) => Promise<void>;
  setSelectedConnection: (id: string | null) => void;
  clearError: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  profiles: [],
  activeConnections: [],
  selectedConnectionId: null,
  loading: false,
  error: null,

  loadProfiles: async () => {
    try {
      set({ loading: true, error: null });
      const profiles = await api.listConnectionProfiles();
      set({ profiles, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  saveProfile: async (profile) => {
    try {
      set({ loading: true, error: null });
      await api.saveConnectionProfile(profile);
      await get().loadProfiles();
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  deleteProfile: async (id) => {
    try {
      set({ loading: true, error: null });
      await api.deleteConnectionProfile(id);
      await get().loadProfiles();
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  connect: async (profileId) => {
    try {
      set({ loading: true, error: null });
      const info = await api.connect(profileId);
      set((state) => ({
        activeConnections: [...state.activeConnections, info],
        selectedConnectionId: info.id,
        loading: false,
      }));
      return info;
    } catch (e) {
      set({ error: String(e), loading: false });
      throw e;
    }
  },

  disconnect: async (connectionId) => {
    try {
      await api.disconnect(connectionId);
      set((state) => ({
        activeConnections: state.activeConnections.filter(
          (c) => c.id !== connectionId,
        ),
        selectedConnectionId:
          state.selectedConnectionId === connectionId
            ? null
            : state.selectedConnectionId,
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setSelectedConnection: (id) => set({ selectedConnectionId: id }),
  clearError: () => set({ error: null }),
}));
