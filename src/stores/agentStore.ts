import { create } from "zustand";
import type { AgentConnection, AgentEndpoint, DataPosture, SetupTarget } from "../lib/bindings";
import { api } from "../lib/tauri-api";

/**
 * What the user has shared with agent harnesses, and where they connect.
 *
 * The state is small on purpose. Everything that decides whether an agent may
 * do something lives in Rust and is asked per tool call; this store is a view
 * of the user's standing decisions, not a cache of permissions. A stale copy
 * here can make the screen wrong, which is a bug — it cannot make an agent
 * more powerful than the user allowed, which would be a different kind of bug
 * entirely.
 */

/** How a connection is shared, with "not at all" as a value rather than null. */
export type Sharing = DataPosture | "none";

/** A change an agent has offered, waiting for the user to decide. */
export interface Proposal {
  /** The request id to answer with. */
  id: string;
  tabId: string;
  tabTitle: string;
  /** What is in the tab now. */
  current: string;
  /** What the agent suggests instead. */
  proposed: string;
  rationale: string;
}

/**
 * A change waiting for the user to say yes.
 *
 * Shaped like the `approve` event rather than like the Rust type, because the
 * dialog renders it and the dialog is what has to be right.
 */
export interface PendingApproval {
  /** The request id to answer with. */
  id: string;
  connection: string;
  environment: string;
  database?: string;
  sql: string;
  /** Measured, not estimated. Absent for a schema change. */
  rowsAffected?: number;
  /** "write" or "schema". */
  change: string;
  reason?: string;
}

interface AgentState {
  endpoint: AgentEndpoint | null;
  connections: AgentConnection[];
  loading: boolean;
  /** The last thing that went wrong, for the dialog to show. */
  error: string | null;
  /** Setup text for the selected harness, once asked for. */
  setup: string | null;
  /**
   * The change waiting for an answer.
   *
   * One at a time: a queue of diffs is a thing nobody reads, and an agent that
   * sends a second proposal before the first is answered is one that should
   * wait.
   */
  proposal: Proposal | null;
  /**
   * The change waiting to be approved.
   *
   * Separate from `proposal`: one is a suggestion about text in an editor, the
   * other is a statement that has already run against a database and is
   * waiting to be kept or thrown away.
   */
  approval: PendingApproval | null;

  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  rotateToken: () => Promise<void>;
  share: (connectionId: string, sharing: Sharing) => Promise<void>;
  unlockDdl: (connectionId: string, unlocked: boolean) => Promise<void>;
  loadSetup: (target: SetupTarget) => Promise<void>;
  showProposal: (proposal: Proposal) => void;
  clearProposal: () => void;
  showApproval: (approval: PendingApproval) => void;
  clearApproval: () => void;
  clearError: () => void;
}

/** Run an action, keeping the last failure visible rather than throwing. */
async function guard(set: (partial: Partial<AgentState>) => void, run: () => Promise<void>) {
  try {
    await run();
  } catch (e) {
    set({ error: String(e instanceof Error ? e.message : e) });
  }
}

export const useAgentStore = create<AgentState>((set) => ({
  endpoint: null,
  connections: [],
  loading: false,
  error: null,
  setup: null,
  proposal: null,
  approval: null,

  refresh: async () => {
    set({ loading: true });
    await guard(set, async () => {
      const [endpoint, connections] = await Promise.all([
        api.agentEndpointStatus(),
        api.listAgentConnections(),
      ]);
      set({ endpoint, connections, error: null });
    });
    set({ loading: false });
  },

  start: async () => {
    await guard(set, async () => {
      set({ endpoint: await api.startAgentEndpoint(), error: null });
    });
  },

  stop: async () => {
    await guard(set, async () => {
      // The setup text names a URL that no longer answers, so it goes with it.
      set({ endpoint: await api.stopAgentEndpoint(), setup: null, error: null });
    });
  },

  rotateToken: async () => {
    await guard(set, async () => {
      // The old setup text carries the old token, and showing it after a
      // rotation would hand the user something that no longer works.
      set({ endpoint: await api.rotateAgentToken(), setup: null, error: null });
    });
  },

  share: async (connectionId, sharing) => {
    await guard(set, async () => {
      if (sharing === "none") {
        await api.revokeAgentConnection(connectionId);
      } else {
        await api.shareConnectionWithAgents(connectionId, sharing);
      }
      set({ connections: await api.listAgentConnections(), error: null });
    });
  },

  unlockDdl: async (connectionId, unlocked) => {
    await guard(set, async () => {
      await api.unlockAgentDdl(connectionId, unlocked);
      set({ connections: await api.listAgentConnections(), error: null });
    });
  },

  loadSetup: async (target) => {
    await guard(set, async () => {
      set({ setup: await api.agentHarnessSetup(target), error: null });
    });
  },

  showProposal: (proposal) => set({ proposal }),

  clearProposal: () => set({ proposal: null }),

  showApproval: (approval) => set({ approval }),

  clearApproval: () => set({ approval: null }),

  clearError: () => set({ error: null }),
}));

/** How a connection is shared right now, for a select. */
export function sharingOf(connection: AgentConnection): Sharing {
  return connection.posture ?? "none";
}

/** What the endpoint's state should say, in one sentence. */
export function endpointSummary(endpoint: AgentEndpoint | null): string {
  if (!endpoint?.running) {
    return "Not listening. Agents cannot reach anything until you start it.";
  }
  return `Listening on ${endpoint.url}. Only this machine can reach it, and only with the token.`;
}

/** The sharing options, in the order they widen. */
export const SHARING_OPTIONS: { value: Sharing; label: string; detail: string }[] = [
  {
    value: "none",
    label: "Not shared",
    detail: "Agents cannot see this connection at all.",
  },
  {
    value: "schema-only",
    label: "Schema only",
    detail: "Names, types and relationships. Queries run, but no row values come back.",
  },
  {
    value: "samples",
    label: "Samples",
    detail: "A bounded number of rows, for the shape of the data.",
  },
  {
    value: "full",
    label: "Full",
    detail: "Rows up to the connection's own cap.",
  },
];

export const SETUP_TARGETS: { value: SetupTarget; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "copilot", label: "GitHub Copilot CLI" },
  { value: "other", label: "Something else" },
];
