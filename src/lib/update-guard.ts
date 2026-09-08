import { useEditorStore } from "../stores/editorStore";
import { useResultStore } from "../stores/resultStore";

/**
 * Why it would be a bad moment to restart into a new version.
 *
 * These checks used to live in the status bar's click handler, which meant
 * two things. The store action was reachable without them — one caller today,
 * but nothing said the next one had to bring its own. And they ran once, at
 * the click, before a download that can take minutes; the restart then
 * happened unconditionally against a state nobody had looked at since (#570).
 *
 * Kept out of the settings store so it can be checked at both moments without
 * that store having to know about queries or editor tabs.
 */
export function updateBlockers(): string[] {
  const reasons: string[] = [];

  if (useResultStore.getState().isExecuting) {
    reasons.push("a query is still running");
  }

  const dirty = useEditorStore.getState().tabs.filter((t) => t.isDirty);
  if (dirty.length > 0) {
    reasons.push(
      dirty.length === 1
        ? "1 editor tab has unsaved changes"
        : `${dirty.length} editor tabs have unsaved changes`,
    );
  }

  return reasons;
}

/** The blockers as one sentence, or null when there are none. */
export function describeUpdateBlockers(): string | null {
  const reasons = updateBlockers();
  if (reasons.length === 0) return null;
  return `Cannot update while ${reasons.join(" and ")}. Save or finish first.`;
}
