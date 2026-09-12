import { useEffect } from "react";
import { connectionIdOf, editorAnswer, proposalRefusal, proposalTarget, resultAnswer } from "../lib/agent-requests";
import { type AgentRequest, events } from "../lib/bindings";
import { api } from "../lib/tauri-api";
import { useAgentStore } from "../stores/agentStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useEditorStore } from "../stores/editorStore";
import { useResultStore } from "../stores/resultStore";

/**
 * The window answering the questions an agent asks of it.
 *
 * Mounted once, at the top of the app. Everything is read at the moment the
 * question arrives rather than kept in sync beforehand: an agent asking what
 * is in the editor gets what is in the editor now, not what was there when the
 * last effect ran.
 *
 * A proposal is the one that does not answer immediately — it puts a diff in
 * front of the user and the answer is whatever they decide. Until then the
 * agent is waiting, which is the correct thing for it to be doing.
 */
export function useAgentRequests() {
  useEffect(() => {
    const unlisten = events.agentRequest.listen(({ payload }) => {
      void handle(payload);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
}

/** Answer one request, or record that we could not. */
async function handle(request: AgentRequest) {
  try {
    switch (request.kind) {
      case "editorContext": {
        const { tabs, activeTabId, editorInstance } = useEditorStore.getState();
        const selection = editorInstance?.getModel()?.getValueInRange(
          editorInstance.getSelection() ?? {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1,
          },
        );
        const answer = editorAnswer(
          tabs,
          activeTabId,
          useConnectionStore.getState().activeConnections,
          selection,
        );
        if (!answer) {
          // A structure or admin tab has no statement to read, and an empty
          // one would have an agent confidently rewriting nothing.
          await fail(request.id, "The active tab is not a query tab, so there is no SQL in it.");
          return;
        }
        await answer_(request.id, answer);
        return;
      }

      case "resultContext": {
        const { results, activeResultIndex } = useResultStore.getState();
        const { tabs, activeTabId } = useEditorStore.getState();
        const tab = tabs.find((t) => t.id === activeTabId);
        await answer_(
          request.id,
          resultAnswer(
            results,
            activeResultIndex,
            tab?.connectionId,
            useConnectionStore.getState().activeConnections,
          ),
        );
        return;
      }

      case "openDraft": {
        const connections = useConnectionStore.getState().activeConnections;
        const editor = useEditorStore.getState();
        const id = editor.openTab("query", {
          // The agent names a profile; tabs work in live connection ids. A
          // profile that is not connected leaves the tab unattached rather
          // than failing — the SQL is still worth having in front of the user.
          connectionId: connectionIdOf(connections, request.connection ?? undefined),
          database: request.database ?? undefined,
        });
        useEditorStore.getState().updateTabContent(id, request.sql);
        if (request.title) useEditorStore.getState().renameTab(id, request.title);
        await answer_(request.id, id);
        return;
      }

      case "proposeEdit": {
        const { tabs, activeTabId } = useEditorStore.getState();
        const target = proposalTarget(tabs, activeTabId, request.tab);
        if (!target) {
          await fail(request.id, proposalRefusal(request.tab));
          return;
        }
        // Not answered here. The dialog answers when the user decides.
        useAgentStore.getState().showProposal({
          id: request.id,
          tabId: target.id,
          tabTitle: target.title,
          current: target.content,
          proposed: request.sql,
          rationale: request.rationale,
        });
        return;
      }

      case "lastError":
        // Answered in Rust from the history store, so it survives the tab
        // being closed. Nothing to do here.
        return;
    }
  } catch (e) {
    await fail(request.id, String(e instanceof Error ? e.message : e));
  }
}

async function answer_(id: string, value: unknown) {
  await api.answerAgentRequest(id, JSON.stringify(value ?? null));
}

async function fail(id: string, error: string) {
  await api.answerAgentRequest(id, undefined, error);
}

/** Send a decision about a proposal. Used by the dialog. */
export async function answerProposal(
  id: string,
  outcome: { accepted: boolean; edited: boolean; sql?: string },
) {
  await api.answerAgentRequest(id, JSON.stringify(outcome));
}
