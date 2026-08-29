import { create } from "zustand";
import { api } from "../lib/tauri-api";
import type { ConnectionInfo, ConnectionProfileInput, ConnectionProfileSummary } from "../types";

interface ConnectionState {
  profiles: ConnectionProfileSummary[];
  activeConnections: ConnectionInfo[];
  selectedConnectionId: string | null;
  loading: boolean;
  error: string | null;
  /**
   * Ids that disconnect was called for before the connection existed on this
   * side — a cancel during a slow connect. Store state rather than a module
   * variable so it resets with everything else.
   */
  pendingDisconnects: string[];

  loadProfiles: () => Promise<void>;
  saveProfile: (profile: ConnectionProfileInput) => Promise<void>;
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
  pendingDisconnects: [],

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

      // Disconnect may have been asked for while this was in flight, before
      // there was anything client-side to remove. Dropping the reference is
      // not enough: the pool exists on the server, so it has to be closed
      // there too, or it lives on with nothing able to reach it (#280).
      if (get().pendingDisconnects.includes(info.id)) {
        set((state) => ({
          pendingDisconnects: state.pendingDisconnects.filter((id) => id !== info.id),
        }));
        try {
          await api.disconnect(info.id);
        } catch {
          // Best effort — the reference is being discarded regardless.
        }
        set({ loading: false });
        throw new Error("Connection cancelled");
      }

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
    // Nothing to close yet — either a connect is still in flight for this id,
    // or the id is unknown. Record the intent so a connect that lands later
    // closes it, and do not call the backend, which would answer "not found"
    // and surface an error for what is a perfectly ordinary cancel.
    if (!get().activeConnections.some((c) => c.id === connectionId)) {
      set((state) => ({
        pendingDisconnects: state.pendingDisconnects.includes(connectionId)
          ? state.pendingDisconnects
          : [...state.pendingDisconnects, connectionId],
        loading: false,
      }));
      return;
    }
    try {
      set({ loading: true, error: null });
      await api.disconnect(connectionId);
      set((state) => ({
        activeConnections: state.activeConnections.filter(
          (c) => c.id !== connectionId,
        ),
        selectedConnectionId: state.selectedConnectionId === connectionId
          ? null
          : state.selectedConnectionId,
        loading: false,
      }));
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  setSelectedConnection: (id) => set({ selectedConnectionId: id }),
  clearError: () => set({ error: null }),
}));
