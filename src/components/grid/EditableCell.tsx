import { useState, useRef, useEffect, useCallback } from "react";
import type { SqlValue } from "../../types";
import { SqlValueGuard } from "../../types";

interface EditableCellProps {
  value: SqlValue;
  dataType: string;
  isEdited: boolean;
  onCommit: (newValue: SqlValue) => void;
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
      setEditValue(SqlValueGuard.toString(value));
    }
    setEditing(true);
  }, [value]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const commitEdit = useCallback(
    (newVal: SqlValue) => {
      setEditing(false);
      onCommit(newVal);
    },
    [onCommit],
  );

  const parseEditValue = useCallback((rawValue: string): SqlValue => {
    if (rawValue === "" && value === null) {
      return null;
    }
    if (rawValue === "") {
      return "";
    }
    if (isNumericType(dataType)) {
      const n = Number(rawValue);
      if (!isNaN(n) && isFinite(n)) {
        return n;
      }
      // If parse fails, keep as string
      return rawValue;
    }
    return rawValue;
  }, [value, dataType]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const parsed = parseEditValue(editValue);
        commitEdit(parsed);
      } else if (e.key === "Escape") {
        cancelEdit();
      } else if (e.key === "Tab") {
        e.preventDefault();
        const parsed = parseEditValue(editValue);
        commitEdit(parsed);
        onTab?.(e.shiftKey);
      }
    },
    [editValue, parseEditValue, commitEdit, cancelEdit, onTab],
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
          checked={SqlValueGuard.isBoolean(value) ? value : SqlValueGuard.isNumber(value) ? value !== 0 : false}
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
          <span className="truncate">{SqlValueGuard.toString(value)}</span>
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
            const parsed = parseEditValue(editValue);
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
          const parsed = parseEditValue(editValue);
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
