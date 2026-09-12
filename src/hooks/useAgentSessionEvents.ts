import { useEffect } from "react";
import { events } from "../lib/bindings";
import { useAgentSessionStore } from "../stores/agentSessionStore";

/**
 * Session events, folded into the transcript.
 *
 * Mounted once and left running, rather than started with the panel: a session
 * keeps going while the panel is closed, and events that arrived in the
 * meantime should be there when it reopens.
 */
export function useAgentSessionEvents() {
  useEffect(() => {
    const unlisten = events.agentSessionEvent.listen(({ payload }) => {
      useAgentSessionStore.getState().receive(payload);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
}
