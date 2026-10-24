import { ChevronDown, ChevronRight, GripVertical, Key, Plus, Trash2 } from "lucide-react";
import { Fragment, useState } from "react";
import {
  canAutoIncrement,
  type DesignerColumn,
  isColumnChanged,
  supportsCharset,
  supportsOnUpdate,
  supportsUnsigned,
} from "../../lib/ddl-generator";
import { cn } from "../../lib/utils";
import { CHARSETS, COLLATIONS, COLUMN_TYPES } from "./constants";

/** The fields a row edits. The modifiers take "" or false for "not set". */
export type ColumnField = keyof Omit<DesignerColumn, "id">;

interface ColumnsTabProps {
  columns: DesignerColumn[];
  originalColumns?: DesignerColumn[];
  /** The columns of the PRIMARY KEY index, in key order. */
  primaryKeyColumns: string[];
  onUpdate: (id: string, field: ColumnField, value: string | boolean) => void;
  /** Add the column to the primary key, or take it out. */
  onTogglePrimaryKey: (name: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onDragStart: (idx: number) => void;
  onDragEnter: (idx: number) => void;
  onDragEnd: () => void;
}

const inputClass =
  "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500";
const selectClass =
  "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500";

/** The list, with a value it does not offer kept selectable (see OptionsTab). */
const withCurrent = (list: readonly string[], current: string | undefined): string[] =>
  current && !list.includes(current) ? [current, ...list] : [...list];

/** Whether a column has a modifier set that only the details row shows. */
function hasDetails(col: DesignerColumn): boolean {
  return (supportsUnsigned(col.type) && !!col.zerofill)
    || (supportsCharset(col.type) && (!!col.charset || !!col.collation))
    || (supportsOnUpdate(col.type) && !!col.onUpdate);
}

/**
 * The column grid.
 *
 * It loaded UNSIGNED, ZEROFILL, charset, collation and ON UPDATE and then
 * showed none of them: an `int unsigned` column read as plain INT while the
 * preview said `INT UNSIGNED`, and there was no way to make a new column
 * unsigned at all (#814). UNSIGNED and the primary key have a column each;
 * the rest sit in a row that opens under the column, so the grid stays
 * narrow, and the toggle is marked when something in it is set.
 */
export function ColumnsTab({
  columns,
  originalColumns,
  primaryKeyColumns,
  onUpdate,
  onTogglePrimaryKey,
  onAdd,
  onRemove,
  onDragStart,
  onDragEnter,
  onDragEnd,
}: ColumnsTabProps) {
  const origMap = new Map(originalColumns?.map((c) => [c.id, c]) || []);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const isChanged = (col: DesignerColumn): boolean => {
    const orig = origMap.get(col.id);
    return !orig || isColumnChanged(orig, col);
  };

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
              <th className="w-6 py-2"></th>
              <th className="w-8 px-1 py-2 text-center" title="Primary key">PK</th>
              <th className="px-1 py-2">Name</th>
              <th className="px-1 py-2">Type</th>
              <th className="w-20 px-1 py-2">Length</th>
              <th className="w-16 px-1 py-2 text-center">Unsigned</th>
              <th className="w-14 px-1 py-2 text-center">Null</th>
              <th className="px-1 py-2">Default</th>
              <th className="w-14 px-1 py-2 text-center">AI</th>
              <th className="px-1 py-2">Comment</th>
              <th className="w-8 py-2"></th>
              <th className="w-8 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col, idx) => {
              const changed = originalColumns ? isChanged(col) : false;
              const label = col.name || "(unnamed)";
              const pkPosition = col.name ? primaryKeyColumns.indexOf(col.name) : -1;
              const numeric = supportsUnsigned(col.type);
              const expanded = open.has(col.id);
              return (
                <Fragment key={col.id}>
                  <tr
                    draggable
                    onDragStart={() => onDragStart(idx)}
                    onDragEnter={() => onDragEnter(idx)}
                    onDragEnd={onDragEnd}
                    onDragOver={(e) => e.preventDefault()}
                    className={cn(
                      "border-b border-[var(--color-border)]",
                      changed && "bg-brand-600/5",
                    )}
                  >
                    <td className="cursor-grab px-1 py-1 text-[var(--color-text-muted)]">
                      <GripVertical className="h-3 w-3" />
                    </td>
                    <td className="px-1 py-1 text-center">
                      {
                        /* The key itself lives in the Indexes tab; this is the
                          same index, reached from where the columns are. */
                      }
                      <button
                        type="button"
                        onClick={() => col.name && onTogglePrimaryKey(col.name)}
                        disabled={!col.name}
                        aria-pressed={pkPosition !== -1}
                        aria-label={`Primary key: ${label}`}
                        title={pkPosition === -1
                          ? "Add to the primary key"
                          : primaryKeyColumns.length > 1
                          ? `Primary key, part ${pkPosition + 1} of ${primaryKeyColumns.length}`
                          : "Primary key"}
                        className={cn(
                          "rounded p-0.5 disabled:opacity-30",
                          pkPosition === -1
                            ? "text-[var(--color-text-muted)] opacity-40 hover:opacity-100"
                            : "text-[var(--color-warning)]",
                        )}
                      >
                        <Key className="h-3 w-3" />
                      </button>
                    </td>
                    <td className="px-1 py-1">
                      <input
                        value={col.name}
                        onChange={(e) => onUpdate(col.id, "name", e.target.value)}
                        placeholder="column_name"
                        aria-label="Column name"
                        className={inputClass}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <select
                        value={col.type}
                        onChange={(e) => onUpdate(col.id, "type", e.target.value)}
                        aria-label={`Type of ${label}`}
                        className={selectClass}
                      >
                        {withCurrent(COLUMN_TYPES, col.type).map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td className="px-1 py-1">
                      <input
                        value={col.length}
                        onChange={(e) => onUpdate(col.id, "length", e.target.value)}
                        placeholder="—"
                        aria-label={`Length of ${label}`}
                        className={inputClass}
                      />
                    </td>
                    <td className="px-1 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={numeric && !!col.unsigned}
                        disabled={!numeric}
                        aria-label={`Unsigned: ${label}`}
                        title={numeric ? undefined : `UNSIGNED needs a numeric type; ${col.type} cannot carry it`}
                        onChange={(e) => onUpdate(col.id, "unsigned", e.target.checked)}
                        className="accent-brand-500 disabled:opacity-40"
                      />
                    </td>
                    <td className="px-1 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={col.nullable}
                        aria-label={`Nullable: ${label}`}
                        onChange={(e) => onUpdate(col.id, "nullable", e.target.checked)}
                        className="accent-brand-500"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        value={col.defaultValue}
                        onChange={(e) => onUpdate(col.id, "defaultValue", e.target.value)}
                        placeholder="—"
                        aria-label={`Default of ${label}`}
                        className={inputClass}
                      />
                    </td>
                    <td className="px-1 py-1 text-center">
                      {
                        /* MySQL rejects AUTO_INCREMENT on anything but an
                          integer type (ERROR 1063), so it is offered only
                          there (#383). */
                      }
                      <input
                        type="checkbox"
                        checked={col.autoIncrement && canAutoIncrement(col.type)}
                        disabled={!canAutoIncrement(col.type)}
                        aria-label={`Auto increment: ${label}`}
                        title={canAutoIncrement(col.type)
                          ? undefined
                          : `AUTO_INCREMENT needs an integer type; ${col.type || "this column"} cannot carry it`}
                        onChange={(e) => onUpdate(col.id, "autoIncrement", e.target.checked)}
                        className="accent-brand-500 disabled:opacity-40"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        value={col.comment}
                        onChange={(e) => onUpdate(col.id, "comment", e.target.value)}
                        placeholder="—"
                        aria-label={`Comment on ${label}`}
                        className={inputClass}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <button
                        type="button"
                        onClick={() => toggleOpen(col.id)}
                        aria-expanded={expanded}
                        aria-label={`More options for ${label}`}
                        title="Zerofill, character set, collation, ON UPDATE"
                        className={cn(
                          "relative rounded p-0.5 hover:bg-[var(--color-bg-tertiary)]",
                          hasDetails(col) ? "text-brand-400" : "text-[var(--color-text-muted)]",
                        )}
                      >
                        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {hasDetails(col) && (
                          <span
                            data-testid="column-details-set"
                            className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-brand-500"
                          />
                        )}
                      </button>
                    </td>
                    <td className="px-1 py-1">
                      <button
                        onClick={() => onRemove(col.id)}
                        aria-label={`Remove column ${label}`}
                        title="Remove column"
                        className="rounded p-0.5 text-[var(--color-text-muted)] hover:surface-error hover:text-[var(--color-error)]"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                      <td colSpan={12} className="px-8 py-2">
                        <ColumnDetails col={col} label={label} onUpdate={onUpdate} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <button
        onClick={onAdd}
        className="mt-3 flex items-center gap-1.5 rounded px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
      >
        <Plus className="h-3.5 w-3.5" />
        Add Column
      </button>
    </div>
  );
}

/** The modifiers that do not earn a grid column, for the types that take them. */
function ColumnDetails({
  col,
  label,
  onUpdate,
}: {
  col: DesignerColumn;
  label: string;
  onUpdate: ColumnsTabProps["onUpdate"];
}) {
  const numeric = supportsUnsigned(col.type);
  const character = supportsCharset(col.type);
  const timestamp = supportsOnUpdate(col.type);
  // Collations that belong to the chosen charset, when one is chosen.
  const collations = col.charset
    ? COLLATIONS.filter((c) => c.startsWith(`${col.charset}_`))
    : COLLATIONS;

  if (!numeric && !character && !timestamp) {
    return (
      <p className="text-[11px] text-[var(--color-text-muted)]">
        {col.type} takes no further options.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-4">
      {numeric && (
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={!!col.zerofill}
            aria-label={`Zerofill: ${label}`}
            onChange={(e) => {
              onUpdate(col.id, "zerofill", e.target.checked);
              // ZEROFILL implies UNSIGNED, and MySQL reports both.
              if (e.target.checked) onUpdate(col.id, "unsigned", true);
            }}
            className="accent-brand-500"
          />
          Zerofill
        </label>
      )}
      {character && (
        <>
          <label className="text-[10px] text-[var(--color-text-muted)]">
            Character set
            <select
              value={col.charset ?? ""}
              onChange={(e) => onUpdate(col.id, "charset", e.target.value)}
              aria-label={`Character set of ${label}`}
              className={cn(selectClass, "mt-0.5 block w-40")}
            >
              <option value="">Table default</option>
              {withCurrent(CHARSETS, col.charset).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-[10px] text-[var(--color-text-muted)]">
            Collation
            <select
              value={col.collation ?? ""}
              onChange={(e) => onUpdate(col.id, "collation", e.target.value)}
              aria-label={`Collation of ${label}`}
              className={cn(selectClass, "mt-0.5 block w-48")}
            >
              <option value="">Charset default</option>
              {withCurrent(collations, col.collation).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </>
      )}
      {timestamp && (
        <label className="text-[10px] text-[var(--color-text-muted)]">
          On update
          <input
            value={col.onUpdate ?? ""}
            onChange={(e) => onUpdate(col.id, "onUpdate", e.target.value)}
            placeholder="CURRENT_TIMESTAMP"
            aria-label={`On update of ${label}`}
            list="designer-on-update"
            className={cn(inputClass, "mt-0.5 block w-48")}
          />
          <datalist id="designer-on-update">
            <option value="CURRENT_TIMESTAMP" />
          </datalist>
        </label>
      )}
    </div>
  );
}
