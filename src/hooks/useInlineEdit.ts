import { useCallback, useRef, useState } from "react";

/**
 * One field being edited in place, in a list.
 *
 * The favorites sidebar held five pieces of state and two refs for this —
 * twice over, once for renaming and once for the description — inline among
 * everything else the panel does (#340). None of it is about favorites; it is
 * the mechanics of an inline editor, and both copies had to get the same
 * subtleties right.
 *
 * The subtleties, both learned from #333:
 *
 * Escape must not commit. The input unmounts, and whether that fires a blur is
 * a detail of the renderer rather than something a cancel should depend on, so
 * the cancel is recorded explicitly and a blur arriving after one is ignored.
 *
 * A rejected value keeps the editor open. Closing it would read as a
 * successful edit that silently did not happen.
 */

export interface InlineEdit {
  /** Which row is being edited, or null. */
  editingId: string | null;
  /** The draft. */
  value: string;
  /** Why the last commit was refused, or null. */
  error: string | null;

  /** Begin editing `id`, seeded with `initial`. */
  start: (id: string, initial: string) => void;
  setValue: (value: string) => void;
  /** Abandon the edit. A blur arriving afterwards is ignored. */
  cancel: () => void;
  /**
   * Commit the draft.
   *
   * `commit` returns null on success, or a message to show and stay open.
   */
  confirm: (commit: (id: string, value: string) => string | null) => void;
}

export interface InlineEditOptions {
  /**
   * Treat an emptied field as a value rather than as a cancel.
   *
   * A name cannot be blank — emptying it and clicking away means "never
   * mind". A description can: clearing one is the only way to remove it, and
   * treating that as a cancel would make it impossible.
   */
  allowEmpty?: boolean;
}

export function useInlineEdit({ allowEmpty = false }: InlineEditOptions = {}): InlineEdit {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const start = useCallback((id: string, initial: string) => {
    setEditingId(id);
    setValue(initial);
    setError(null);
    cancelled.current = false;
  }, []);

  const cancel = useCallback(() => {
    cancelled.current = true;
    setEditingId(null);
    setValue("");
    setError(null);
  }, []);

  const confirm = useCallback(
    (commit: (id: string, value: string) => string | null) => {
      if (cancelled.current) return;
      const trimmed = value.trim();
      if (!editingId || (!trimmed && !allowEmpty)) {
        cancel();
        return;
      }

      const refusal = commit(editingId, trimmed);
      if (refusal) {
        setError(refusal);
        return;
      }

      setEditingId(null);
      setValue("");
      setError(null);
    },
    [editingId, value, cancel, allowEmpty],
  );

  const setDraft = useCallback((next: string) => {
    setValue(next);
    setError(null);
  }, []);

  return { editingId, value, error, start, setValue: setDraft, cancel, confirm };
}
