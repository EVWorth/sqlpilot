import { useState, useRef, useEffect, useCallback } from "react";

interface EditableCellProps {
  value: unknown;
  dataType: string;
  isEdited: boolean;
  onCommit: (newValue: unknown) => void;
  onTab?: (shiftKey: boolean) => void;
}

function isNumericType(dt: string): boolean {
  const t = dt.toLowerCase();
  return /int|decimal|numeric|float|double|real|bit/.test(t);
}

function isBooleanType(dt: string): boolean {
  return /^(bool|boolean|tinyint\(1\))$/i.test(dt);
}

function isLongTextType(dt: string): boolean {
  const t = dt.toLowerCase();
  return /text|blob|json|mediumtext|longtext/.test(t);
}

export function EditableCell({
  value,
  dataType,
  isEdited,
  onCommit,
  onTab,
}: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (inputRef.current instanceof HTMLInputElement) {
        inputRef.current.select();
      }
    }
  }, [editing]);

  const startEdit = useCallback(() => {
    if (value === null) {
      setEditValue("");
    } else {
      setEditValue(String(value));
    }
    setEditing(true);
  }, [value]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const commitEdit = useCallback(
    (newVal: unknown) => {
      setEditing(false);
      onCommit(newVal);
    },
    [onCommit],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        let parsed: unknown = editValue;
        if (editValue === "" && value === null) {
          parsed = null;
        } else if (isNumericType(dataType) && editValue !== "") {
          const n = Number(editValue);
          if (!isNaN(n)) parsed = n;
        }
        commitEdit(parsed);
      } else if (e.key === "Escape") {
        cancelEdit();
      } else if (e.key === "Tab") {
        e.preventDefault();
        let parsed: unknown = editValue;
        if (editValue === "" && value === null) {
          parsed = null;
        } else if (isNumericType(dataType) && editValue !== "") {
          const n = Number(editValue);
          if (!isNaN(n)) parsed = n;
        }
        commitEdit(parsed);
        onTab?.(e.shiftKey);
      }
    },
    [editValue, dataType, value, commitEdit, cancelEdit, onTab],
  );

  const toggleNull = useCallback(() => {
    if (value === null) {
      // Restore to empty string
      onCommit("");
    } else {
      onCommit(null);
    }
    setEditing(false);
  }, [value, onCommit]);

  // Boolean checkbox
  if (isBooleanType(dataType) && !editing) {
    return (
      <div
        className={`flex items-center gap-1 ${isEdited ? "border-l-2 border-amber-400 pl-1" : ""}`}
        onDoubleClick={startEdit}
      >
        <input
          type="checkbox"
          checked={value === true || value === 1}
          onChange={(e) => onCommit(e.target.checked ? 1 : 0)}
          className="h-3 w-3 accent-brand-500"
        />
        <button
          onClick={toggleNull}
          className="ml-auto text-[9px] text-[var(--color-text-muted)] opacity-0 hover:opacity-100 group-hover:opacity-60"
          title={value === null ? "Set value" : "Set NULL"}
        >
          {value === null ? "∅" : "N"}
        </button>
      </div>
    );
  }

  // Display mode
  if (!editing) {
    return (
      <div
        className={`group flex min-h-[20px] cursor-text items-center ${isEdited ? "border-l-2 border-amber-400 pl-1" : ""}`}
        onDoubleClick={startEdit}
      >
        {value === null ? (
          <span className="italic text-[var(--color-text-muted)]">NULL</span>
        ) : (
          <span className="truncate">{String(value)}</span>
        )}
      </div>
    );
  }

  // Edit mode: textarea for long text
  if (isLongTextType(dataType)) {
    return (
      <div className="relative flex items-center gap-0.5">
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            let parsed: unknown = editValue;
            if (editValue === "" && value === null) parsed = null;
            commitEdit(parsed);
          }}
          rows={3}
          className="w-full resize-y rounded border border-brand-500 bg-[var(--color-bg-primary)] px-1 py-0.5 text-xs text-[var(--color-text-primary)] outline-none"
        />
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleNull();
          }}
          className="shrink-0 rounded px-0.5 text-[9px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
          title={value === null ? "Set value" : "Set NULL"}
        >
          ∅
        </button>
      </div>
    );
  }

  // Edit mode: number or text input
  return (
    <div className="relative flex items-center gap-0.5">
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type={isNumericType(dataType) ? "number" : "text"}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          let parsed: unknown = editValue;
          if (editValue === "" && value === null) parsed = null;
          else if (isNumericType(dataType) && editValue !== "") {
            const n = Number(editValue);
            if (!isNaN(n)) parsed = n;
          }
          commitEdit(parsed);
        }}
        className="w-full rounded border border-brand-500 bg-[var(--color-bg-primary)] px-1 py-0.5 text-xs text-[var(--color-text-primary)] outline-none"
      />
      <button
        onMouseDown={(e) => {
          e.preventDefault();
          toggleNull();
        }}
        className="shrink-0 rounded px-0.5 text-[9px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
        title={value === null ? "Set value" : "Set NULL"}
      >
        ∅
      </button>
    </div>
  );
}
