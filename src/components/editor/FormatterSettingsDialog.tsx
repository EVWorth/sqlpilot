import { useState, useEffect } from "react";
import { Settings2 } from "lucide-react";
import { useSettingsStore, type FormatterSettings } from "../../stores/settingsStore";

interface FormatterSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const DEFAULTS: FormatterSettings = {
  keywordCase: "upper",
  identifierCase: "preserve",
  dataTypeCase: "upper",
  functionCase: "preserve",
  indentStyle: "standard",
  tabWidth: 2,
  useTabs: false,
  logicalOperatorNewline: "before",
  newlineBeforeSemicolon: false,
  expressionWidth: 50,
  linesBetweenQueries: 1,
  denseOperators: false,
};

type CaseOption = "upper" | "lower" | "preserve";

export function FormatterSettingsDialog({ isOpen, onClose }: FormatterSettingsDialogProps) {
  const { formatterSettings, setFormatterSettings } = useSettingsStore();
  // Always merge with defaults so new fields are never undefined
  const [local, setLocal] = useState<FormatterSettings>({ ...DEFAULTS, ...formatterSettings });

  // Reset local state each time the dialog opens so stale edits never appear
  useEffect(() => {
    if (isOpen) setLocal({ ...DEFAULTS, ...formatterSettings });
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  const handleSave = () => {
    setFormatterSettings(local);
    onClose();
  };

  const labelClass = "text-xs text-[var(--color-text-muted)] mb-1 block";
  const inputClass =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]";

  function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
    return (
      <button
        type="button"
        onClick={onChange}
        className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors border border-[var(--color-border)] ${
          value ? "bg-[var(--color-accent)]" : "bg-[var(--color-bg-tertiary)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
            value ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    );
  }

  function CaseSelect({ label, value, onChange }: { label: string; value: CaseOption; onChange: (v: CaseOption) => void }) {
    return (
      <div>
        <label className={labelClass}>{label}</label>
        <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value as CaseOption)}>
          <option value="preserve">Preserve</option>
          <option value="upper">UPPER</option>
          <option value="lower">lower</option>
        </select>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-80 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <Settings2 className="h-4 w-4 text-[var(--color-text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            SQL Formatter Settings
          </h2>
        </div>

        <div className="max-h-[70vh] overflow-y-auto space-y-4 p-4">

          {/* Casing */}
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Casing</p>

          <CaseSelect label="Keywords" value={local.keywordCase} onChange={(v) => setLocal({ ...local, keywordCase: v })} />
          <CaseSelect label="Identifiers (table/column names)" value={local.identifierCase} onChange={(v) => setLocal({ ...local, identifierCase: v })} />
          <CaseSelect label="Data types" value={local.dataTypeCase} onChange={(v) => setLocal({ ...local, dataTypeCase: v })} />
          <CaseSelect label="Functions" value={local.functionCase} onChange={(v) => setLocal({ ...local, functionCase: v })} />

          {/* Indentation */}
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] pt-1">Indentation</p>

          <div>
            <label className={labelClass}>Indent style</label>
            <select
              className={inputClass}
              value={local.indentStyle}
              onChange={(e) =>
                setLocal({ ...local, indentStyle: e.target.value as FormatterSettings["indentStyle"] })
              }
            >
              <option value="standard">Standard</option>
              <option value="tabularLeft">Tabular left</option>
              <option value="tabularRight">Tabular right</option>
            </select>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <span className={labelClass + " mb-0"}>Indent using tabs</span>
              <span className="block text-[10px] text-[var(--color-text-muted)] opacity-70">Overrides tab width</span>
            </div>
            <Toggle value={local.useTabs} onChange={() => setLocal({ ...local, useTabs: !local.useTabs })} />
          </div>

          {!local.useTabs && (
            <div>
              <label className={labelClass}>Tab width</label>
              <input
                type="number"
                min={1}
                max={8}
                className={inputClass}
                value={local.tabWidth}
                onChange={(e) =>
                  setLocal({ ...local, tabWidth: Math.max(1, Math.min(8, Number(e.target.value))) })
                }
              />
            </div>
          )}

          {/* Layout */}
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] pt-1">Layout</p>

          <div>
            <label className={labelClass}>Logical operator newline</label>
            <select
              className={inputClass}
              value={local.logicalOperatorNewline}
              onChange={(e) =>
                setLocal({
                  ...local,
                  logicalOperatorNewline: e.target.value as FormatterSettings["logicalOperatorNewline"],
                })
              }
            >
              <option value="before">Before (AND/OR at line start)</option>
              <option value="after">After (AND/OR at line end)</option>
            </select>
          </div>

          <div>
            <label className={labelClass}>Expression width</label>
            <input
              type="number"
              min={10}
              max={200}
              className={inputClass}
              value={local.expressionWidth}
              onChange={(e) =>
                setLocal({ ...local, expressionWidth: Math.max(10, Math.min(200, Number(e.target.value))) })
              }
            />
          </div>

          <div>
            <label className={labelClass}>Lines between queries</label>
            <input
              type="number"
              min={0}
              max={5}
              className={inputClass}
              value={local.linesBetweenQueries}
              onChange={(e) =>
                setLocal({ ...local, linesBetweenQueries: Math.max(0, Math.min(5, Number(e.target.value))) })
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <span className={labelClass + " mb-0"}>Dense operators</span>
            <Toggle value={local.denseOperators} onChange={() => setLocal({ ...local, denseOperators: !local.denseOperators })} />
          </div>

          <div className="flex items-center justify-between">
            <span className={labelClass + " mb-0"}>Newline before semicolon</span>
            <Toggle
              value={local.newlineBeforeSemicolon}
              onChange={() => setLocal({ ...local, newlineBeforeSemicolon: !local.newlineBeforeSemicolon })}
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-3">
          <button
            onClick={() => setLocal(DEFAULTS)}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            Reset to defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded px-3 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 transition-opacity"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
