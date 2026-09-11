import { useMemo, useState } from "react";
import { dataUri, decodeUtf8, detectMime, formatBytes, HEX_COLUMNS, hexDump, looksLikeText } from "../../lib/blob";

/**
 * A binary cell, in the three ways FR-3.1.9 asks for.
 *
 * Which tab opens first is decided by the bytes: an image opens as an image,
 * something that reads as text opens as text, and anything else opens as hex —
 * because for a compiled blob the hex *is* the content, and dropping the user
 * on an empty-looking text pane would suggest the value was empty (#401).
 *
 * Tabs that cannot say anything are not shown. An image tab on a value no
 * `<img>` can render is a broken-icon placeholder, which is worse than not
 * offering one.
 */

export type BlobTab = "image" | "text" | "hex";

/** Beyond this the hex pane stops building lines; a 50 MB value is 3.2M of them. */
const HEX_BYTE_LIMIT = 64 * 1024;

export function BlobViewer({ bytes, columnName }: { bytes: number[]; columnName: string }) {
  const mime = useMemo(() => detectMime(bytes), [bytes]);
  const textual = useMemo(() => looksLikeText(bytes), [bytes]);

  const tabs = useMemo<BlobTab[]>(() => {
    const available: BlobTab[] = [];
    if (mime) available.push("image");
    if (textual) available.push("text");
    available.push("hex");
    return available;
  }, [mime, textual]);

  const [tab, setTab] = useState<BlobTab>(() => tabs[0]);

  const lines = useMemo(
    () => (tab === "hex" ? hexDump(bytes, HEX_BYTE_LIMIT) : []),
    [tab, bytes],
  );
  const text = useMemo(() => (tab === "text" ? decodeUtf8(bytes) : ""), [tab, bytes]);
  const src = useMemo(
    () => (tab === "image" && mime ? dataUri(bytes, mime) : null),
    [tab, mime, bytes],
  );

  const truncated = bytes.length > HEX_BYTE_LIMIT;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1 text-xs">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={`rounded px-2 py-0.5 capitalize transition-colors ${
              tab === t
                ? "bg-brand-600/20 text-brand-400"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {t}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">
          {mime ?? "unrecognised"} &middot; {formatBytes(bytes.length)}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2">
        {tab === "image" && src && (
          <img
            src={src}
            alt={`${columnName} contents`}
            className="mx-auto max-h-full max-w-full object-contain"
          />
        )}

        {tab === "text" && (
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-[var(--color-text-primary)]">
            {text}
          </pre>
        )}

        {tab === "hex" && (
          <table className="font-mono text-[11px] leading-tight">
            <tbody>
              {lines.map((line) => (
                <tr key={line.offset}>
                  <td className="pr-3 text-right text-[var(--color-text-muted)] tabular-nums">
                    {line.offset.toString(16).padStart(8, "0")}
                  </td>
                  <td className="whitespace-pre pr-3 text-[var(--color-text-primary)]">
                    {line.hex}
                  </td>
                  <td className="whitespace-pre text-[var(--color-text-secondary)]">
                    {line.ascii}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {tab === "hex" && truncated && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Showing the first {formatBytes(HEX_BYTE_LIMIT)} of {formatBytes(bytes.length)} — rendering{" "}
          {Math.ceil(bytes.length / HEX_COLUMNS).toLocaleString()} lines would lock the window up.
        </p>
      )}
    </div>
  );
}
