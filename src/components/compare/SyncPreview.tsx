import { useState, useCallback } from "react";
import {
  Copy,
  Check,
  ChevronLeft,
  AlertTriangle,
  Loader2,
  Play,
} from "lucide-react";
import { api } from "../../lib/tauri-api";
import { cn } from "../../lib/utils";
import type { SyncStatement } from "../../lib/sync-sql-generator";

interface SyncPreviewProps {
  statements: SyncStatement[];
  targetConnectionId: string;
  targetDatabase: string;
  onBack: () => void;
}

export function SyncPreview({ statements, targetConnectionId, targetDatabase, onBack }: SyncPreviewProps) {
  const [selected, setSelected] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    statements.forEach((s, i) => {
      if (!s.destructive) initial.add(i);
    });
    return initial;
  });
  const [executing, setExecuting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [results, setResults] = useState<{ index: number; success: boolean; error?: string }[]>([]);
  const [copied, setCopied] = useState(false);

  const toggle = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === statements.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(statements.map((_, i) => i)));
    }
  };

  const handleCopy = useCallback(async () => {
    const sql = statements
      .filter((_, i) => selected.has(i))
      .map((s) => s.sql)
      .join("\n\n");
    await navigator.clipboard.writeText(sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [statements, selected]);

  const handleExecute = useCallback(async () => {
    setExecuting(true);
    setResults([]);
    const newResults: { index: number; success: boolean; error?: string }[] = [];

    const sortedIndexes = Array.from(selected).sort((a, b) => a - b);
    for (const index of sortedIndexes) {
      const stmt = statements[index];
      // Strip comment lines before executing
      const cleanSql = stmt.sql
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n")
        .trim();
      if (!cleanSql) continue;

      try {
        await api.executeQuery(targetConnectionId, `USE ${targetDatabase}`);
        await api.executeQuery(targetConnectionId, cleanSql);
        newResults.push({ index, success: true });
      } catch (e) {
        newResults.push({ index, success: false, error: String(e) });
      }
    }

    setResults(newResults);
    setExecuting(false);
    setShowConfirm(false);
  }, [selected, statements, targetConnectionId, targetDatabase]);

  const selectedCount = selected.size;
  const destructiveCount = statements.filter((s, i) => selected.has(i) && s.destructive).length;

  const colorMap: Record<string, string> = {
    create: "border-l-green-500",
    alter: "border-l-yellow-500",
    drop: "border-l-red-500",
  };

  const labelColorMap: Record<string, string> = {
    create: "text-green-400 bg-green-500/10",
    alter: "text-yellow-400 bg-yellow-500/10",
    drop: "text-red-400 bg-red-500/10",
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back to comparison
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy Selected"}
          </button>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={selectedCount === 0 || executing}
            className="flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {executing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Execute Selected ({selectedCount})
          </button>
        </div>
      </div>

      {/* Select All */}
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={selected.size === statements.length}
            onChange={toggleAll}
            className="rounded"
          />
          Select all ({statements.length} statements)
        </label>
        {destructiveCount > 0 && (
          <span className="flex items-center gap-1 text-red-400">
            <AlertTriangle className="h-3 w-3" />
            {destructiveCount} destructive
          </span>
        )}
      </div>

      {/* Statements */}
      <div className="space-y-1.5">
        {statements.map((stmt, index) => {
          const result = results.find((r) => r.index === index);
          return (
            <div
              key={index}
              className={cn(
                "rounded border border-[var(--color-border)] border-l-2 bg-[var(--color-bg-secondary)]",
                colorMap[stmt.type],
                result?.success === true && "border-l-green-500 opacity-60",
                result?.success === false && "border-l-red-500",
              )}
            >
              <div className="flex items-start gap-2 p-2">
                <input
                  type="checkbox"
                  checked={selected.has(index)}
                  onChange={() => toggle(index)}
                  className="mt-1 rounded"
                />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", labelColorMap[stmt.type])}>
                      {stmt.type.toUpperCase()}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-secondary)]">
                      {stmt.objectType} {stmt.objectName}
                    </span>
                    {stmt.destructive && (
                      <AlertTriangle className="h-3 w-3 text-red-400" />
                    )}
                    {result?.success === true && (
                      <Check className="h-3 w-3 text-green-400" />
                    )}
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-[11px] text-[var(--color-text-primary)] font-mono leading-relaxed">
                    {stmt.sql}
                  </pre>
                  {result?.error && (
                    <div className="mt-1 rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-400">
                      {result.error}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Confirmation Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-96 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-5 shadow-xl">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
              Confirm Sync Execution
            </h3>
            <p className="mb-1 text-xs text-[var(--color-text-secondary)]">
              Execute {selectedCount} statement{selectedCount !== 1 ? "s" : ""} on{" "}
              <span className="font-medium">{targetDatabase}</span>?
            </p>
            {destructiveCount > 0 && (
              <p className="mb-3 flex items-center gap-1.5 text-xs text-red-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                {destructiveCount} destructive statement{destructiveCount !== 1 ? "s" : ""} (DROP/column removal)
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
              >
                Cancel
              </button>
              <button
                onClick={handleExecute}
                disabled={executing}
                className="flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-60"
              >
                {executing && <Loader2 className="h-3 w-3 animate-spin" />}
                Execute
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
