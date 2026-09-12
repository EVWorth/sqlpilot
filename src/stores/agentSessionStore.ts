import { create } from "zustand";
import { addUserMessage, answerPermission, applyEvent, type TranscriptItem } from "../lib/agent-transcript";
import type { AgentSessionEvent, Harness, HarnessStatus } from "../lib/bindings";
import { api } from "../lib/tauri-api";

/**
 * The agent session in the panel.
 *
 * One at a time. Several sessions at once is slice 4 of the design, and
 * building the UI for it before the single case is right would be building the
 * hard version of a thing nobody has used yet.
 *
 * The transcript is folded from events by `agent-transcript`, which is where
 * the rules live; this store is the part that talks to the backend and holds
 * what came back.
 */

interface AgentSessionState {
  /** Harnesses on this machine. Empty until looked for. */
  harnesses: HarnessStatus[];
  /** SQLPilot's id for the running session, or null. */
  session: string | null;
  /** What the harness calls itself, for the header. */
  agent: string | null;
  /**
   * False when the session has no database tools — the harness could not take
   * our MCP server. Worth saying: the agent will otherwise look oddly blind.
   */
  toolsAvailable: boolean;
  /** True between sending a message and the turn ending. */
  thinking: boolean;
  transcript: TranscriptItem[];
  error: string | null;
  /** True while a session is being started, which takes a second or two. */
  starting: boolean;

  findHarnesses: () => Promise<void>;
  start: (harness: Harness) => Promise<void>;
  send: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  stop: () => Promise<void>;
  answer: (requestId: string, optionId?: string) => Promise<void>;
  /** Fold an event in. Called by the listener, and by tests. */
  receive: (event: AgentSessionEvent) => void;
  clearError: () => void;
}

export const useAgentSessionStore = create<AgentSessionState>((set, get) => ({
  harnesses: [],
  session: null,
  agent: null,
  toolsAvailable: false,
  thinking: false,
  transcript: [],
  error: null,
  starting: false,

  findHarnesses: async () => {
    try {
      set({ harnesses: await api.listHarnesses(), error: null });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  start: async (harness) => {
    set({ starting: true, error: null });
    try {
      const started = await api.startAgentSession(harness);
      set({
        session: started.session,
        agent: `${started.agent} ${started.version}`.trim(),
        toolsAvailable: started.toolsAvailable,
        // A fresh session starts with an empty transcript: the old one
        // belonged to a process that is gone.
        transcript: [],
        thinking: false,
      });
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ starting: false });
    }
  },

  send: async (text) => {
    const { session } = get();
    if (!session || !text.trim()) return;
    // Shown immediately: waiting for the round trip to echo the user's own
    // message back reads as a dropped keystroke.
    set({ transcript: addUserMessage(get().transcript, text), thinking: true, error: null });
    try {
      await api.sendAgentMessage(session, text);
    } catch (e) {
      set({ error: message(e), thinking: false });
    }
  },

  cancel: async () => {
    const { session } = get();
    if (!session) return;
    try {
      await api.cancelAgentTurn(session);
    } catch (e) {
      set({ error: message(e) });
    }
  },

  stop: async () => {
    const { session } = get();
    if (!session) return;
    try {
      await api.stopAgentSession(session);
    } catch (e) {
      set({ error: message(e) });
    }
    set({ session: null, agent: null, thinking: false });
  },

  answer: async (requestId, optionId) => {
    const { session } = get();
    // Marked answered first, so a second click cannot send a second answer.
    set({ transcript: answerPermission(get().transcript, requestId, optionId) });
    if (!session) return;
    try {
      await api.answerAgentPermission(session, requestId, optionId);
    } catch (e) {
      set({ error: message(e) });
    }
  },

  receive: ({ session, event }) => {
    // Events from a session that has been replaced are dropped rather than
    // folded into the new one's transcript.
    if (session !== get().session) return;

    set({
      transcript: applyEvent(get().transcript, event),
      // A permission request pauses the turn, but the agent is still working
      // on it — only an ending stops the spinner.
      thinking: event.type === "turnEnded" || event.type === "failed" ? false : get().thinking,
    });
  },

  clearError: () => set({ error: null }),
}));

function message(e: unknown): string {
  return String(e instanceof Error ? e.message : e);
}
