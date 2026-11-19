import { useCallback } from "react";
import { CopyRefused, writeClipboardText } from "../lib/clipboard";
import { COPY_FORMAT_LABEL, type CopyFormat, type CopySource, renderCopy } from "../lib/copy-formats";
import { rowsToCopy, type Selection } from "../lib/grid-selection";
import type { ResultMeta, RowSource } from "../lib/row-source";
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
  /**
   * The footer's Copy button: every row in the view, tab-separated, in the
   * order the grid shows them.
   *
   * The clipboard write starts here, inside the click, and is filled in when
   * the rows arrive: see `writeClipboardText`.
   */
  const copyAll = useCallback(async () => {
    if (!result) return;
    let copied = 0;
    const text = source.allRows().then((fetched) => {
      copied = fetched.length;
      const header = result.columns.map((c) => c.name).join("\t");
      const rows = fetched
        .map((row) => row.map((v) => SqlValueGuard.toString(v)).join("\t"))
        .join("\n");
      return header + "\n" + rows;
    });
    try {
      await writeClipboardText(text);
    } catch (e) {
      onMessage(`Copy failed: ${String(e)}`);
      return;
    }
    onMessage(`Copied ${plural(copied)} to clipboard`);
  }, [result, source, onMessage]);

  /**
   * Copy the selected rows — or every row in the view, when nothing is
   * selected — in one of the formats FR-3.3 asks for.
   *
   * The SQL formats need to know which table the rows came from and what
   * identifies one, and neither can be invented: an INSERT into `your_table`
   * fails on paste (#409), and an UPDATE with no WHERE rewrites the table.
   */
  const copyAs = useCallback(async (format: CopyFormat) => {
    if (!result) return;
    const { rowCount } = source;
    let copied = 0;
    const text = (async () => {
      // Selected rows are copied in the order they are on screen (#858), which
      // the source knows; nothing selected means the whole view, in order.
      let fetched;
      if (selection.rows.size > 0) {
        const order = await source.order([...selection.rows]);
        fetched = await source.rows(rowsToCopy(selection, rowCount, order));
      } else {
        fetched = await source.allRows();
      }
      copied = fetched.length;
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
      if ("refusal" in rendered) throw new CopyRefused(rendered.refusal);
      return rendered.text;
    })();
    try {
      await writeClipboardText(text);
    } catch (e) {
      // A refused copy explains itself; the clipboard keeps what it had.
      const refusal = await text.then(() => null, (r: unknown) => (r instanceof CopyRefused ? r.reason : null));
      onMessage(refusal ?? `Copy failed: ${String(e)}`);
      return;
    }
    onMessage(`Copied ${plural(copied)} as ${COPY_FORMAT_LABEL[format]}`);
  }, [result, source, selection, orderedColumns, rowKey.state, onMessage]);

  /** Download the whole result, rendered by the backend's exporter. */
  const exportAs = useCallback(async (format: string) => {
    if (!result) return;
    try {
      // The exporter takes a whole result: every row in the view, in the
      // order the grid shows them.
      const rows = await source.allRows();
      const content = await api.exportResults({ ...result, rows }, format);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      downloadBlob(content, `query-results-${ts}.${EXT[format]}`, MIME[format]);
      onMessage(`Exported ${plural(rows.length)} as ${format.toUpperCase()}`);
    } catch {
      onMessage("Export failed — try Copy instead");
    }
  }, [result, source, onMessage]);

  return { copyAll, copyAs, exportAs };
}

/** "1 row", "2 rows", "1,000 rows". */
function plural(n: number): string {
  return `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;
}
