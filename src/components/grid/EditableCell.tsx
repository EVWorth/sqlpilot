import { useCallback, useEffect, useRef, useState } from "react";
import {
  isBooleanSqlType,
  isExactNumericType,
  isLongTextSqlType,
  isNumericSqlType,
  parseBooleanInput,
} from "../../lib/sql-types";
import type { SqlValue } from "../../types";
import { SqlValueGuard } from "../../types";

interface EditableCellProps {
  value: SqlValue;
  dataType: string;
  isEdited: boolean;
  onCommit: (newValue: SqlValue) => void;
  onTab?: (shiftKey: boolean) => void;
}

export function EditableCell({
  value,
  dataType,
  isEdited,
  onCommit,
  onTab,
}: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  // Set when the typed text is not a value this column can hold, so the cell
  // can say so instead of writing something the server would reinterpret.
  const [invalid, setInvalid] = useState(false);
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

  const parseEditValue = useCallback((rawValue: string): SqlValue | undefined => {
    if (rawValue === "" && value === null) {
      return null;
    }
    if (rawValue === "") {
      return "";
    }
    // A boolean column takes 0 or 1. Anything else must not be handed to
    // MySQL, which converts a non-numeric string to 0 without complaint.
    if (isBooleanSqlType(dataType)) {
      return parseBooleanInput(rawValue);
    }
    // BIGINT and DECIMAL keep their digits as text: Number() would drop the
    // last digit of a large id or the exactness of a decimal, corrupting the
    // row on save. The SQL generator emits them unquoted from the column type.
    if (isExactNumericType(dataType)) {
      return rawValue;
    }
    if (isNumericSqlType(dataType)) {
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
        if (parsed === undefined) {
          setInvalid(true);
          return;
        }
        commitEdit(parsed);
      } else if (e.key === "Escape") {
        cancelEdit();
      } else if (e.key === "Tab") {
        e.preventDefault();
        const parsed = parseEditValue(editValue);
        if (parsed === undefined) {
          setInvalid(true);
          return;
        }
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
  if (isBooleanSqlType(dataType) && !editing) {
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
        className={`group flex min-h-[20px] cursor-text items-center ${
          isEdited ? "border-l-2 border-amber-400 pl-1" : ""
        }`}
        onDoubleClick={startEdit}
      >
        {value === null
          ? <span className="italic text-[var(--color-text-muted)]">NULL</span>
          : <span className="truncate">{SqlValueGuard.toString(value)}</span>}
      </div>
    );
  }

  // Edit mode: textarea for long text
  if (isLongTextSqlType(dataType)) {
    return (
      <div className="relative flex items-center gap-0.5">
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={editValue}
          onChange={(e) => {
            setEditValue(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            const parsed = parseEditValue(editValue);
            // Long-text columns are never boolean, so this cannot currently be
            // undefined — guarded anyway so a future type with its own parsing
            // rules cannot slip an unreadable value through here.
            if (parsed === undefined) {
              cancelEdit();
              return;
            }
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
        type={isNumericSqlType(dataType) && !isExactNumericType(dataType) ? "number" : "text"}
        inputMode={isNumericSqlType(dataType) ? "numeric" : undefined}
        value={editValue}
        onChange={(e) => {
          setEditValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          const parsed = parseEditValue(editValue);
          // Leaving the cell must not write a value it could not read.
          if (parsed === undefined) {
            cancelEdit();
            return;
          }
          commitEdit(parsed);
        }}
        title={invalid ? "Enter 0 or 1 (or true/false, yes/no, on/off)" : undefined}
        aria-invalid={invalid || undefined}
        className={`w-full rounded border bg-[var(--color-bg-primary)] px-1 py-0.5 text-xs text-[var(--color-text-primary)] outline-none ${
          invalid ? "border-red-500" : "border-brand-500"
        }`}
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
