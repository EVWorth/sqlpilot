import { useCallback } from "react";
import { COPY_FORMAT_LABEL, type CopyFormat, type CopySource, renderCopy } from "../lib/copy-formats";
import { describeSelection, rowsToCopy, type Selection } from "../lib/grid-selection";
import { allIndices, type ResultMeta, type RowSource } from "../lib/row-source";
import { resolveEditTarget } from "../lib/sql-generator";
import { api } from "../lib/tauri-api";
import type { ColumnMeta } from "../types";
import { SqlValueGuard } from "../types";
import type { RowKey } from "./useRowKey";

/**
 * Getting rows out of the grid: to the clipboard, or to a file.
 *
 * Split out of ResultsGrid (#406). Downloading and rendering a copy format
 * have nothing to do with drawing a table, and both are easier to reason about
 * with the component out of the way.
 */

const MIME: Record<string, string> = {
  csv: "text/csv",
  json: "application/json",
  sql: "text/plain",
  markdown: "text/markdown",
};

const EXT: Record<string, string> = {
  csv: "csv",
  json: "json",
  sql: "sql",
  markdown: "md",
};

/** Hand the browser a file. */
function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface UseGridExportOptions {
  result: ResultMeta | undefined;
  /** Where the rows are read from. Every copy and export waits for it. */
  source: RowSource;
  /** Columns in display order, so a copy matches what is on screen. */
  orderedColumns: ColumnMeta[];
  selection: Selection;
  /** What identifies a row, for the UPDATE format (#387). */
  rowKey: RowKey;
  onMessage: (message: string) => void;
}

export function useGridExport({
  result,
  source,
  orderedColumns,
  selection,
  rowKey,
  onMessage,
}: UseGridExportOptions) {
  /** The footer's Copy button: every row, tab-separated. */
  const copyAll = useCallback(async () => {
    if (!result) return;
    let fetched;
    try {
      // The result as the server returned it, whatever the sort and filters.
      fetched = await source.rows(allIndices(source));
    } catch (e) {
      onMessage(`Copy failed: ${String(e)}`);
      return;
    }
    const header = result.columns.map((c) => c.name).join("\t");
    const rows = fetched
      .map((row) => row.map((v) => SqlValueGuard.toString(v)).join("\t"))
      .join("\n");
    await navigator.clipboard.writeText(header + "\n" + rows);
    onMessage(`Copied ${fetched.length} rows to clipboard`);
  }, [result, source, onMessage]);

  /**
   * Copy the selected rows — or all of them, when nothing is selected — in
   * one of the formats FR-3.3 asks for.
   *
   * The SQL formats need to know which table the rows came from and what
   * identifies one, and neither can be invented: an INSERT into `your_table`
   * fails on paste (#409), and an UPDATE with no WHERE rewrites the table.
   */
  const copyAs = useCallback(async (format: CopyFormat) => {
    if (!result) return;
    const { rowCount } = source;
    let fetched;
    try {
      // Selected rows are copied in the order they are on screen (#858), which
      // the source knows; nothing selected means the result as returned.
      const order = selection.rows.size > 0 ? await source.order([...selection.rows]) : undefined;
      fetched = await source.rows(rowsToCopy(selection, rowCount, order));
    } catch (e) {
      onMessage(`Copy failed: ${String(e)}`);
      return;
    }
    const columnAt = orderedColumns.map((c) => result.columns.findIndex((rc) => rc.name === c.name));
    const copy: CopySource = {
      columns: orderedColumns.map((c) => ({ name: c.name, dataType: c.data_type })),
      rows: fetched.map((row) => columnAt.map((at) => row[at])),
    };

    const target = resolveEditTarget(result.sql ?? "");
    const rendered = renderCopy(format, copy, {
      table: target.editable ? target.table : null,
      keyColumns: rowKey.state.status === "ready" ? rowKey.state.columns : [],
    });

    if ("refusal" in rendered) {
      onMessage(rendered.refusal);
      return;
    }
    await navigator.clipboard.writeText(rendered.text);
    onMessage(
      `Copied ${describeSelection(selection, rowCount)} as ${COPY_FORMAT_LABEL[format]}`,
    );
  }, [result, source, selection, orderedColumns, rowKey.state, onMessage]);

  /** Download the whole result, rendered by the backend's exporter. */
  const exportAs = useCallback(async (format: string) => {
    if (!result) return;
    try {
      // The exporter takes a whole result; the rows are the source's, as the
      // server returned them.
      const rows = await source.rows(allIndices(source));
      const content = await api.exportResults({ ...result, rows }, format);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      downloadBlob(content, `query-results-${ts}.${EXT[format]}`, MIME[format]);
      onMessage(`Exported ${rows.length} rows as ${format.toUpperCase()}`);
    } catch {
      onMessage("Export failed — try Copy instead");
    }
  }, [result, source, onMessage]);

  return { copyAll, copyAs, exportAs };
}
