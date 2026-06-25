import {
  AlertCircle,
  Check,
  Columns3,
  Eye,
  GripVertical,
  Key,
  Link2,
  Loader2,
  Plus,
  Save,
  Settings,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DesignerColumn,
  type DesignerForeignKey,
  type DesignerIndex,
  generateAlterTable,
  generateCreateTable,
  type TableDesignerConfig,
  type TableOptions,
} from "../../lib/ddl-generator";
import { api } from "../../lib/tauri-api";
import { cn } from "../../lib/utils";
import type { ColumnInfo, IndexInfo, TableInfo } from "../../types";
import { SQLPreviewDialog } from "./SQLPreviewDialog";

// --- Constants ---

const COLUMN_TYPES = [
  "INT",
  "BIGINT",
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "VARCHAR",
  "CHAR",
  "TEXT",
  "TINYTEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "DECIMAL",
  "FLOAT",
  "DOUBLE",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "TIME",
  "YEAR",
  "BOOLEAN",
  "ENUM",
  "SET",
  "BLOB",
  "JSON",
  "BINARY",
  "VARBINARY",
] as const;

const INDEX_TYPES = ["PRIMARY KEY", "UNIQUE", "INDEX", "FULLTEXT"] as const;
const FK_ACTIONS = ["RESTRICT", "CASCADE", "SET NULL", "NO ACTION"] as const;
const ENGINES = ["InnoDB", "MyISAM", "MEMORY", "CSV", "ARCHIVE"] as const;
const CHARSETS = ["utf8mb4", "utf8", "latin1", "ascii", "binary"] as const;
const COLLATIONS = [
  "utf8mb4_general_ci",
  "utf8mb4_unicode_ci",
  "utf8mb4_bin",
  "utf8_general_ci",
  "utf8_unicode_ci",
  "latin1_swedish_ci",
  "latin1_general_ci",
] as const;

type SubTab = "columns" | "indexes" | "foreignKeys" | "options";

interface TableDesignerProps {
  connectionId: string;
  database: string;
  tableName?: string;
}

const defaultOptions: TableOptions = {
  engine: "InnoDB",
  charset: "utf8mb4",
  collation: "utf8mb4_general_ci",
  autoIncrementStart: "1",
  comment: "",
};

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

function newColumn(): DesignerColumn {
  return {
    id: nextId("col"),
    name: "",
    type: "INT",
    length: "",
    nullable: true,
    defaultValue: "",
    autoIncrement: false,
    comment: "",
  };
}

function newIndex(): DesignerIndex {
  return {
    id: nextId("idx"),
    name: "",
    type: "INDEX",
    columns: [],
  };
}

function newForeignKey(): DesignerForeignKey {
  return {
    id: nextId("fk"),
    name: "",
    columns: [],
    referenceTable: "",
    referenceColumns: [],
    onDelete: "RESTRICT",
    onUpdate: "RESTRICT",
  };
}

export function TableDesigner({ connectionId, database, tableName }: TableDesignerProps) {
  const isAlter = !!tableName;

  const [activeSubTab, setActiveSubTab] = useState<SubTab>("columns");
  const [tblName, setTblName] = useState(tableName || "");
  const [columns, setColumns] = useState<DesignerColumn[]>([newColumn()]);
  const [indexes, setIndexes] = useState<DesignerIndex[]>([]);
  const [foreignKeys, setForeignKeys] = useState<DesignerForeignKey[]>([]);
  const [options, setOptions] = useState<TableOptions>({ ...defaultOptions });

  const [originalConfig, setOriginalConfig] = useState<TableDesignerConfig | null>(null);
  const [loading, setLoading] = useState(isAlter);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const [refTables, setRefTables] = useState<TableInfo[]>([]);
  const [refTableColumns, setRefTableColumns] = useState<Record<string, string[]>>({});

  // Load reference tables for FK tab
  useEffect(() => {
    api.getTables(connectionId, database).then(setRefTables).catch((e) =>
      console.error("Failed to load reference tables", e)
    );
  }, [connectionId, database]);

  // Load columns for reference tables as needed
  const loadRefTableColumns = useCallback(
    async (table: string) => {
      if (refTableColumns[table]) return;
      try {
        const cols = await api.getColumns(connectionId, database, table);
        setRefTableColumns((prev) => ({
          ...prev,
          [table]: cols.map((c) => c.name),
        }));
      } catch {
        // ignore
      }
    },
    [connectionId, database, refTableColumns],
  );

  // Load existing table data in ALTER mode
  useEffect(() => {
    if (!isAlter || !tableName) return;

    const load = async () => {
      try {
        setLoading(true);
        const [colsData, idxData] = await Promise.all([
          api.getColumns(connectionId, database, tableName),
          api.getIndexes(connectionId, database, tableName),
        ]);

        const loadedCols: DesignerColumn[] = colsData.map((c: ColumnInfo) => ({
          id: nextId("col"),
          name: c.name,
          type: extractBaseType(c.column_type),
          length: extractLength(c.column_type),
          nullable: c.nullable,
          defaultValue: c.default_value ?? "",
          autoIncrement: c.extra.toLowerCase().includes("auto_increment"),
          comment: c.comment,
        }));

        const loadedIdxs: DesignerIndex[] = idxData.map((i: IndexInfo) => ({
          id: nextId("idx"),
          name: i.name,
          type: i.name === "PRIMARY"
            ? "PRIMARY KEY" as const
            : i.is_unique
            ? "UNIQUE" as const
            : i.index_type === "FULLTEXT"
            ? "FULLTEXT" as const
            : "INDEX" as const,
          columns: i.columns,
        }));

        setColumns(loadedCols.length > 0 ? loadedCols : [newColumn()]);
        setIndexes(loadedIdxs);
        setTblName(tableName);

        const config: TableDesignerConfig = {
          tableName,
          database,
          columns: loadedCols.length > 0 ? loadedCols : [newColumn()],
          indexes: loadedIdxs,
          foreignKeys: [],
          options: { ...defaultOptions },
        };
        setOriginalConfig(config);
      } catch (e) {
        setError(`Failed to load table structure: ${e}`);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isAlter, tableName, connectionId, database]);

  const currentConfig = useCallback((): TableDesignerConfig => ({
    tableName: tblName,
    database,
    columns,
    indexes,
    foreignKeys,
    options,
  }), [tblName, database, columns, indexes, foreignKeys, options]);

  const generateSql = useCallback(() => {
    const config = currentConfig();
    if (isAlter && originalConfig) {
      return generateAlterTable(tableName!, originalConfig, config);
    }
    return generateCreateTable(config);
  }, [currentConfig, isAlter, originalConfig, tableName]);

  const handleSave = async () => {
    const sql = generateSql();
    if (sql.startsWith("--")) {
      setError(sql);
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await api.executeQuery(connectionId, sql);
      setSuccess("Table saved successfully!");
      setTimeout(() => setSuccess(null), 3000);
      if (isAlter) {
        setOriginalConfig(currentConfig());
      }
    } catch (e) {
      setError(`Failed to execute: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  // --- Column operations ---
  const updateColumn = (id: string, field: keyof DesignerColumn, value: string | boolean) => {
    setColumns((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  const addColumn = () => setColumns((prev) => [...prev, newColumn()]);
  const removeColumn = (id: string) => setColumns((prev) => prev.filter((c) => c.id !== id));

  // --- Drag reorder ---
  const dragItem = useRef<number | null>(null);
  const dragOver = useRef<number | null>(null);

  const handleDragStart = (idx: number) => {
    dragItem.current = idx;
  };
  const handleDragEnter = (idx: number) => {
    dragOver.current = idx;
  };
  const handleDragEnd = () => {
    if (dragItem.current === null || dragOver.current === null) return;
    const from = dragItem.current;
    const to = dragOver.current;
    if (from !== to) {
      setColumns((prev) => {
        const copy = [...prev];
        const [moved] = copy.splice(from, 1);
        copy.splice(to, 0, moved);
        return copy;
      });
    }
    dragItem.current = null;
    dragOver.current = null;
  };

  // --- Index operations ---
  const updateIndex = (id: string, field: keyof DesignerIndex, value: unknown) => {
    setIndexes((prev) => prev.map((i) => (i.id === id ? { ...i, [field]: value } : i)));
  };
  const addIndex = () => setIndexes((prev) => [...prev, newIndex()]);
  const removeIndex = (id: string) => setIndexes((prev) => prev.filter((i) => i.id !== id));

  // --- FK operations ---
  const updateFK = (id: string, field: keyof DesignerForeignKey, value: unknown) => {
    setForeignKeys((prev) => prev.map((f) => (f.id === id ? { ...f, [field]: value } : f)));
  };
  const addFK = () => setForeignKeys((prev) => [...prev, newForeignKey()]);
  const removeFK = (id: string) => setForeignKeys((prev) => prev.filter((f) => f.id !== id));

  const subTabs: { key: SubTab; label: string; icon: typeof Columns3 }[] = [
    { key: "columns", label: "Columns", icon: Columns3 },
    { key: "indexes", label: "Indexes", icon: Key },
    { key: "foreignKeys", label: "Foreign Keys", icon: Link2 },
    { key: "options", label: "Options", icon: Settings },
  ];

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg-primary)]">
        <Loader2 className="h-6 w-6 animate-spin text-brand-400" />
        <span className="ml-2 text-sm text-[var(--color-text-muted)]">Loading table structure…</span>
      </div>
    );
  }

  const columnNames = columns.filter((c) => c.name).map((c) => c.name);

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)]">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-2">
        <label className="text-xs text-[var(--color-text-muted)]">Table:</label>
        <input
          value={tblName}
          onChange={(e) => setTblName(e.target.value)}
          placeholder="table_name"
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500"
        />
        <span className="text-xs text-[var(--color-text-muted)]">in {database}</span>
        <div className="ml-auto flex items-center gap-2">
          {error && (
            <span className="flex items-center gap-1 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5" />
              {error}
            </span>
          )}
          {success && (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <Check className="h-3.5 w-3.5" />
              {success}
            </span>
          )}
          <button
            onClick={() => setShowPreview(true)}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <Eye className="h-3.5 w-3.5" />
            Preview SQL
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {isAlter ? "Apply Changes" : "Create Table"}
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        {subTabs.map((st) => (
          <button
            key={st.key}
            onClick={() => setActiveSubTab(st.key)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2 text-xs transition-colors",
              activeSubTab === st.key
                ? "border-b-2 border-brand-500 text-[var(--color-text-primary)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
            )}
          >
            <st.icon className="h-3.5 w-3.5" />
            {st.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-4">
        {activeSubTab === "columns" && (
          <ColumnsTab
            columns={columns}
            originalColumns={originalConfig?.columns}
            onUpdate={updateColumn}
            onAdd={addColumn}
            onRemove={removeColumn}
            onDragStart={handleDragStart}
            onDragEnter={handleDragEnter}
            onDragEnd={handleDragEnd}
          />
        )}
        {activeSubTab === "indexes" && (
          <IndexesTab
            indexes={indexes}
            columnNames={columnNames}
            onUpdate={updateIndex}
            onAdd={addIndex}
            onRemove={removeIndex}
          />
        )}
        {activeSubTab === "foreignKeys" && (
          <ForeignKeysTab
            foreignKeys={foreignKeys}
            columnNames={columnNames}
            refTables={refTables}
            refTableColumns={refTableColumns}
            onLoadRefColumns={loadRefTableColumns}
            onUpdate={updateFK}
            onAdd={addFK}
            onRemove={removeFK}
          />
        )}
        {activeSubTab === "options" && <OptionsTab options={options} onChange={setOptions} />}
      </div>

      {showPreview && (
        <SQLPreviewDialog
          sql={generateSql()}
          onClose={() => setShowPreview(false)}
          onExecute={handleSave}
        />
      )}
    </div>
  );
}

// --- Sub-components ---

function ColumnsTab({
  columns,
  originalColumns,
  onUpdate,
  onAdd,
  onRemove,
  onDragStart,
  onDragEnter,
  onDragEnd,
}: {
  columns: DesignerColumn[];
  originalColumns?: DesignerColumn[];
  onUpdate: (id: string, field: keyof DesignerColumn, value: string | boolean) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onDragStart: (idx: number) => void;
  onDragEnter: (idx: number) => void;
  onDragEnd: () => void;
}) {
  const origMap = new Map(originalColumns?.map((c) => [c.id, c]) || []);

  const isChanged = (col: DesignerColumn): boolean => {
    const orig = origMap.get(col.id);
    if (!orig) return true;
    return (
      orig.name !== col.name
      || orig.type !== col.type
      || orig.length !== col.length
      || orig.nullable !== col.nullable
      || orig.defaultValue !== col.defaultValue
      || orig.autoIncrement !== col.autoIncrement
      || orig.comment !== col.comment
    );
  };

  const inputClass =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500";
  const selectClass =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500";

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
              <th className="w-6 py-2"></th>
              <th className="px-1 py-2">Name</th>
              <th className="px-1 py-2">Type</th>
              <th className="w-20 px-1 py-2">Length</th>
              <th className="w-14 px-1 py-2 text-center">Null</th>
              <th className="px-1 py-2">Default</th>
              <th className="w-14 px-1 py-2 text-center">AI</th>
              <th className="px-1 py-2">Comment</th>
              <th className="w-8 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col, idx) => {
              const changed = originalColumns ? isChanged(col) : false;
              return (
                <tr
                  key={col.id}
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
                  <td className="px-1 py-1">
                    <input
                      value={col.name}
                      onChange={(e) => onUpdate(col.id, "name", e.target.value)}
                      placeholder="column_name"
                      className={inputClass}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <select
                      value={col.type}
                      onChange={(e) => onUpdate(col.id, "type", e.target.value)}
                      className={selectClass}
                    >
                      {COLUMN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td className="px-1 py-1">
                    <input
                      value={col.length}
                      onChange={(e) => onUpdate(col.id, "length", e.target.value)}
                      placeholder="—"
                      className={inputClass}
                    />
                  </td>
                  <td className="px-1 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={col.nullable}
                      onChange={(e) => onUpdate(col.id, "nullable", e.target.checked)}
                      className="accent-brand-500"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      value={col.defaultValue}
                      onChange={(e) => onUpdate(col.id, "defaultValue", e.target.value)}
                      placeholder="—"
                      className={inputClass}
                    />
                  </td>
                  <td className="px-1 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={col.autoIncrement}
                      onChange={(e) => onUpdate(col.id, "autoIncrement", e.target.checked)}
                      className="accent-brand-500"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      value={col.comment}
                      onChange={(e) => onUpdate(col.id, "comment", e.target.value)}
                      placeholder="—"
                      className={inputClass}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <button
                      onClick={() => onRemove(col.id)}
                      className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
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

function IndexesTab({
  indexes,
  columnNames,
  onUpdate,
  onAdd,
  onRemove,
}: {
  indexes: DesignerIndex[];
  columnNames: string[];
  onUpdate: (id: string, field: keyof DesignerIndex, value: unknown) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const inputClass =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500";
  const selectClass =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500";

  const toggleColumn = (idx: DesignerIndex, colName: string) => {
    const next = idx.columns.includes(colName)
      ? idx.columns.filter((c) => c !== colName)
      : [...idx.columns, colName];
    onUpdate(idx.id, "columns", next);
  };

  return (
    <div>
      {indexes.length === 0
        ? <p className="text-xs text-[var(--color-text-muted)]">No indexes defined.</p>
        : (
          <div className="space-y-3">
            {indexes.map((idx) => (
              <div
                key={idx.id}
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div>
                      <label className="mb-0.5 block text-[10px] text-[var(--color-text-muted)]">Name</label>
                      <input
                        value={idx.name}
                        onChange={(e) => onUpdate(idx.id, "name", e.target.value)}
                        placeholder="index_name"
                        disabled={idx.type === "PRIMARY KEY"}
                        className={cn(inputClass, "w-48")}
                      />
                    </div>
                    <div>
                      <label className="mb-0.5 block text-[10px] text-[var(--color-text-muted)]">Type</label>
                      <select
                        value={idx.type}
                        onChange={(e) => onUpdate(idx.id, "type", e.target.value)}
                        className={cn(selectClass, "w-36")}
                      >
                        {INDEX_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                  <button
                    onClick={() => onRemove(idx.id)}
                    className="rounded p-1 text-[var(--color-text-muted)] hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] text-[var(--color-text-muted)]">Columns</label>
                  <div className="flex flex-wrap gap-1.5">
                    {columnNames.map((colName) => (
                      <button
                        key={colName}
                        onClick={() => toggleColumn(idx, colName)}
                        className={cn(
                          "rounded border px-2 py-0.5 text-[10px] transition-colors",
                          idx.columns.includes(colName)
                            ? "border-brand-500 bg-brand-600/20 text-brand-300"
                            : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]",
                        )}
                      >
                        {colName}
                      </button>
                    ))}
                    {columnNames.length === 0 && (
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        Add columns in the Columns tab first
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      <button
        onClick={onAdd}
        className="mt-3 flex items-center gap-1.5 rounded px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
      >
        <Plus className="h-3.5 w-3.5" />
        Add Index
      </button>
    </div>
  );
}

function ForeignKeysTab({
  foreignKeys,
  columnNames,
  refTables,
  refTableColumns,
  onLoadRefColumns,
  onUpdate,
  onAdd,
  onRemove,
}: {
  foreignKeys: DesignerForeignKey[];
  columnNames: string[];
  refTables: TableInfo[];
  refTableColumns: Record<string, string[]>;
  onLoadRefColumns: (table: string) => void;
  onUpdate: (id: string, field: keyof DesignerForeignKey, value: unknown) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const inputClass =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500";
  const selectClass =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500";

  const toggleColumn = (fk: DesignerForeignKey, field: "columns" | "referenceColumns", colName: string) => {
    const current = fk[field];
    const next = current.includes(colName)
      ? current.filter((c) => c !== colName)
      : [...current, colName];
    onUpdate(fk.id, field, next);
  };

  return (
    <div>
      {foreignKeys.length === 0
        ? <p className="text-xs text-[var(--color-text-muted)]">No foreign keys defined.</p>
        : (
          <div className="space-y-3">
            {foreignKeys.map((fk) => (
              <div
                key={fk.id}
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <label className="mb-0.5 block text-[10px] text-[var(--color-text-muted)]">Constraint Name</label>
                    <input
                      value={fk.name}
                      onChange={(e) => onUpdate(fk.id, "name", e.target.value)}
                      placeholder="fk_name"
                      className={cn(inputClass, "w-48")}
                    />
                  </div>
                  <button
                    onClick={() => onRemove(fk.id)}
                    className="rounded p-1 text-[var(--color-text-muted)] hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="mb-2 grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-[10px] text-[var(--color-text-muted)]">Column(s)</label>
                    <div className="flex flex-wrap gap-1">
                      {columnNames.map((cn) => (
                        <button
                          key={cn}
                          onClick={() => toggleColumn(fk, "columns", cn)}
                          className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
                            fk.columns.includes(cn)
                              ? "border-brand-500 bg-brand-600/20 text-brand-300"
                              : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                          }`}
                        >
                          {cn}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] text-[var(--color-text-muted)]">Reference Table</label>
                    <select
                      value={fk.referenceTable}
                      onChange={(e) => {
                        const table = e.target.value;
                        onUpdate(fk.id, "referenceTable", table);
                        onUpdate(fk.id, "referenceColumns", []);
                        if (table) onLoadRefColumns(table);
                      }}
                      className={selectClass}
                    >
                      <option value="">Select table…</option>
                      {refTables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                    </select>

                    {fk.referenceTable && refTableColumns[fk.referenceTable] && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {refTableColumns[fk.referenceTable].map((cn) => (
                          <button
                            key={cn}
                            onClick={() => toggleColumn(fk, "referenceColumns", cn)}
                            className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
                              fk.referenceColumns.includes(cn)
                                ? "border-brand-500 bg-brand-600/20 text-brand-300"
                                : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                            }`}
                          >
                            {cn}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex gap-3">
                  <div>
                    <label className="mb-0.5 block text-[10px] text-[var(--color-text-muted)]">ON DELETE</label>
                    <select
                      value={fk.onDelete}
                      onChange={(e) => onUpdate(fk.id, "onDelete", e.target.value)}
                      className={cn(selectClass, "w-32")}
                    >
                      {FK_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[10px] text-[var(--color-text-muted)]">ON UPDATE</label>
                    <select
                      value={fk.onUpdate}
                      onChange={(e) => onUpdate(fk.id, "onUpdate", e.target.value)}
                      className={cn(selectClass, "w-32")}
                    >
                      {FK_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      <button
        onClick={onAdd}
        className="mt-3 flex items-center gap-1.5 rounded px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
      >
        <Plus className="h-3.5 w-3.5" />
        Add Foreign Key
      </button>
    </div>
  );
}

function OptionsTab({
  options,
  onChange,
}: {
  options: TableOptions;
  onChange: (opts: TableOptions) => void;
}) {
  const update = (field: keyof TableOptions, value: string) => {
    onChange({ ...options, [field]: value });
  };

  const selectClass =
    "rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500";
  const inputClass =
    "rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500";

  return (
    <div className="max-w-md space-y-4">
      <div>
        <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Engine</label>
        <select
          value={options.engine}
          onChange={(e) => update("engine", e.target.value)}
          className={cn(selectClass, "w-full")}
        >
          {ENGINES.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Character Set</label>
        <select
          value={options.charset}
          onChange={(e) => update("charset", e.target.value)}
          className={cn(selectClass, "w-full")}
        >
          {CHARSETS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Collation</label>
        <select
          value={options.collation}
          onChange={(e) => update("collation", e.target.value)}
          className={cn(selectClass, "w-full")}
        >
          {COLLATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Auto Increment Start</label>
        <input
          value={options.autoIncrementStart}
          onChange={(e) => update("autoIncrementStart", e.target.value)}
          type="number"
          min="1"
          className={cn(inputClass, "w-full")}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Comment</label>
        <textarea
          value={options.comment}
          onChange={(e) => update("comment", e.target.value)}
          rows={3}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500"
        />
      </div>
    </div>
  );
}

// --- Helpers ---

function extractBaseType(columnType: string): string {
  const upper = columnType.toUpperCase();
  // Match type name before parenthesis or space
  const match = upper.match(/^([A-Z]+)/);
  if (!match) return "VARCHAR";
  const base = match[1];
  // Map some MySQL types
  if (base === "INT" || base === "INTEGER") return "INT";
  return COLUMN_TYPES.includes(base as typeof COLUMN_TYPES[number]) ? base : "VARCHAR";
}

function extractLength(columnType: string): string {
  const match = columnType.match(/\(([^)]+)\)/);
  return match ? match[1] : "";
}
