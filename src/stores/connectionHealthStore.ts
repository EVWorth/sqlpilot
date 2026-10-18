import { create } from "zustand";
import type { ConnectionHealth } from "../lib/bindings";
import { events } from "../lib/bindings";
import { api } from "../lib/tauri-api";

/**
 * Whether each live connection is still answering.
 *
 * The backend pings every connection on a schedule and reports the changes;
 * this holds the last word on each. Before it existed, a tab whose server had
 * gone looked exactly like one whose server was fine, right up until the next
 * query failed with "Connection not found" (#276).
 */
interface ConnectionHealthState {
  /** By connection id. Absent means nothing has been reported yet. */
  health: Record<string, ConnectionHealth>;

  /** Start listening. Returns the teardown, for the effect that called it. */
  start: () => Promise<() => void>;
  /** Ask now rather than waiting for the next scheduled check. */
  refresh: (connectionId: string) => Promise<void>;
  /** Drop what is known about a connection, on disconnect. */
  forget: (connectionId: string) => void;
}

export const useConnectionHealthStore = create<ConnectionHealthState>((set, get) => ({
  health: {},

  start: async () => {
    const unlisten = await events.connectionHealthEvent.listen((e) => {
      const health = e.payload;
      set((state) => ({ health: { ...state.health, [health.connectionId]: health } }));
    }).catch((e) => {
      // A listener that cannot attach means no live updates; a query still
      // reports its own failure. Not a reason to leave the app in a broken
      // state.
      console.warn("Could not subscribe to connection health events", e);
      return () => {};
    });

    return unlisten;
  },

  refresh: async (connectionId) => {
    try {
      const health = await api.pingConnection(connectionId);
      set((state) => ({ health: { ...state.health, [connectionId]: health } }));
    } catch (e) {
      // The command itself failing — an id that is no longer live — is the
      // same news as an unhealthy ping.
      set((state) => ({
        health: {
          ...state.health,
          [connectionId]: {
            connectionId,
            healthy: false,
            latencyMs: null,
            error: String(e),
            consecutiveFailures: state.health[connectionId]?.consecutiveFailures ?? 1,
          },
        },
      }));
    }
  },

  forget: (connectionId) => {
    const nextHealth = { ...get().health };
    delete nextHealth[connectionId];
    set({ health: nextHealth });
  },
}));
