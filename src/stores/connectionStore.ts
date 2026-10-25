import { create } from "zustand";
import { api } from "../lib/tauri-api";
import { errorMessage } from "../lib/utils";
import type { ConnectionInfo, ConnectionProfileInput, ConnectionProfileSummary } from "../types";
import { useConnectionHealthStore } from "./connectionHealthStore";
import { useSchemaStore } from "./schemaStore";

interface ConnectionState {
  profiles: ConnectionProfileSummary[];
  activeConnections: ConnectionInfo[];
  selectedConnectionId: string | null;
  loading: boolean;
  error: string | null;
  /** The profile whose connect produced `error`, if a connect did. */
  failedProfileId: string | null;
  /**
   * Ids that disconnect was called for before the connection existed on this
   * side — a cancel during a slow connect. Store state rather than a module
   * variable so it resets with everything else.
   */
  pendingDisconnects: string[];
  /**
   * Profiles with a connect in flight, so each can show its own placeholder
   * tab. `loading` is shared with loading, saving and deleting profiles, so
   * reading it painted every tab "Connecting" for any of them (#799).
   */
  connecting: string[];
  /**
   * The attempt token of each profile's in-flight connect. Per attempt, not
   * per profile: after a cancel the user can connect again while the
   * cancelled attempt is still running, and the two must not be confused.
   */
  connectAttempts: Record<string, number>;
  /** Attempt tokens of in-flight connects the user cancelled. */
  cancelledConnects: number[];
  /**
   * Open connections whose profile was edited since they connected, in a way
   * that only takes effect on a new connection: a host, a user, a password.
   * The session still points where it did, and the tab says so (#831).
   */
  staleConnections: string[];

  loadProfiles: () => Promise<void>;
  saveProfile: (profile: ConnectionProfileInput) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  connect: (profileId: string) => Promise<ConnectionInfo>;
  disconnect: (connectionId: string) => Promise<void>;
  /** Abandon the in-flight connect for a profile; its result is closed on arrival. */
  cancelConnect: (profileId: string) => void;
  /** Mark an open connection as running on settings that have since changed. */
  markStale: (connectionId: string) => void;
  /** Close a connection and open its profile again, with the profile's current settings. */
  reconnect: (connectionId: string) => Promise<ConnectionInfo>;
  setSelectedConnection: (id: string | null) => void;
  clearError: () => void;
}

/** Source of attempt tokens; only ever compared for equality. */
let nextConnectAttempt = 0;

/** `attempts` without `profileId`'s entry. */
function withoutAttempt(attempts: Record<string, number>, profileId: string): Record<string, number> {
  return Object.fromEntries(Object.entries(attempts).filter(([id]) => id !== profileId));
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  profiles: [],
  activeConnections: [],
  selectedConnectionId: null,
  loading: false,
  error: null,
  failedProfileId: null,
  pendingDisconnects: [],
  connecting: [],
  connectAttempts: {},
  cancelledConnects: [],
  staleConnections: [],

  loadProfiles: async () => {
    try {
      set({ loading: true, error: null, failedProfileId: null });
      const profiles = await api.listConnectionProfiles();
      set({ profiles, loading: false });
    } catch (e) {
      set({ error: errorMessage(e), loading: false });
    }
  },

  saveProfile: async (profile) => {
    try {
      set({ loading: true, error: null, failedProfileId: null });
      await api.saveConnectionProfile(profile);
      await get().loadProfiles();
    } catch (e) {
      set({ error: errorMessage(e), loading: false });
      // The dialog has to know, or it closes and takes the form with it (#792).
      throw e;
    }
  },

  deleteProfile: async (id) => {
    try {
      set({ loading: true, error: null, failedProfileId: null });
      await api.deleteConnectionProfile(id);
      await get().loadProfiles();
    } catch (e) {
      set({ error: errorMessage(e), loading: false });
    }
  },

  connect: async (profileId) => {
    const attempt = ++nextConnectAttempt;
    set((state) => ({
      error: null,
      failedProfileId: null,
      connecting: state.connecting.includes(profileId)
        ? state.connecting
        : [...state.connecting, profileId],
      connectAttempts: { ...state.connectAttempts, [profileId]: attempt },
    }));
    /**
     * This attempt is over. Only clears the placeholder if it is still this
     * attempt's: a cancelled attempt finishing late must not remove a retry's.
     */
    const settle = () =>
      set((state) => {
        if (state.connectAttempts[profileId] !== attempt) return {};
        return {
          connecting: state.connecting.filter((id) => id !== profileId),
          connectAttempts: withoutAttempt(state.connectAttempts, profileId),
        };
      });
    /** Whether the user cancelled this attempt; consumes the request. */
    const takeCancel = () => {
      if (!get().cancelledConnects.includes(attempt)) return false;
      set((state) => ({
        cancelledConnects: state.cancelledConnects.filter((t) => t !== attempt),
      }));
      return true;
    };

    let info: ConnectionInfo;
    try {
      info = await api.connect(profileId);
    } catch (e) {
      settle();
      // A failure nobody is waiting for any more is not worth reporting.
      // Rejected, not thrown: lint wants a `cause` on a throw inside a catch,
      // and the ES2021 target has no `cause` option.
      if (takeCancel()) return Promise.reject(new Error("Connection cancelled"));
      // Which profile failed, so the failure can offer Retry and Edit (#804).
      set({ error: errorMessage(e), failedProfileId: profileId });
      throw e;
    }
    settle();

    // Disconnect may have been asked for while this was in flight, before
    // there was anything client-side to remove. Dropping the reference is
    // not enough: the pool exists on the server, so it has to be closed
    // there too, or it lives on with nothing able to reach it (#280).
    const cancelled = takeCancel();
    if (cancelled || get().pendingDisconnects.includes(info.id)) {
      set((state) => ({
        pendingDisconnects: state.pendingDisconnects.filter((id) => id !== info.id),
      }));
      try {
        await api.disconnect(info.id);
      } catch {
        // Best effort — the reference is being discarded regardless.
      }
      throw new Error("Connection cancelled");
    }

    set((state) => ({
      activeConnections: [...state.activeConnections, info],
      selectedConnectionId: info.id,
    }));
    return info;
  },

  cancelConnect: (profileId) => {
    const attempt = get().connectAttempts[profileId];
    if (attempt === undefined || !get().connecting.includes(profileId)) return;
    set((state) => ({
      connecting: state.connecting.filter((id) => id !== profileId),
      connectAttempts: withoutAttempt(state.connectAttempts, profileId),
      cancelledConnects: [...state.cancelledConnects, attempt],
    }));
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
      set({ loading: true, error: null, failedProfileId: null });
      await api.disconnect(connectionId);
      // The schema is about a server this app is no longer talking to.
      // Keeping it means a reconnect shows what was true before, and means
      // the cache grows by one server per session (#288).
      useSchemaStore.getState().forget(connectionId);
      // Same reasoning for the health record: it describes a connection that
      // no longer exists, and a later id could otherwise inherit its state.
      useConnectionHealthStore.getState().forget(connectionId);
      set((state) => ({
        activeConnections: state.activeConnections.filter(
          (c) => c.id !== connectionId,
        ),
        selectedConnectionId: state.selectedConnectionId === connectionId
          ? null
          : state.selectedConnectionId,
        staleConnections: state.staleConnections.filter((id) => id !== connectionId),
        loading: false,
      }));
    } catch (e) {
      set({ error: errorMessage(e), loading: false });
    }
  },

  markStale: (connectionId) =>
    set((state) => ({
      staleConnections: state.staleConnections.includes(connectionId)
        ? state.staleConnections
        : [...state.staleConnections, connectionId],
    })),

  reconnect: async (connectionId) => {
    const old = get().activeConnections.find((c) => c.id === connectionId);
    if (!old) throw new Error("Connection not found");
    await get().disconnect(connectionId);
    // A failed close leaves it open and says why in `error`; opening a second
    // one beside it would be the duplicate the connect flow guards against.
    if (get().activeConnections.some((c) => c.id === connectionId)) {
      throw new Error(get().error ?? "Could not close the connection");
    }
    return get().connect(old.profile_id);
  },

  setSelectedConnection: (id) => set({ selectedConnectionId: id }),
  clearError: () => set({ error: null, failedProfileId: null }),
}));
