import type { ActionContext } from "../lib/actions";
import { useConnectionStore } from "../stores/connectionStore";

/** The state `Action.enabled` is decided from, kept current from the stores (#821). */
export function useActionContext(): ActionContext {
  const connected = useConnectionStore((s) =>
    s.selectedConnectionId !== null && s.activeConnections.some((c) => c.id === s.selectedConnectionId)
  );
  return { connected };
}
