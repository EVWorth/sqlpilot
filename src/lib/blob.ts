/**
 * Making binary columns readable.
 *
 * BLOBs arrive as a byte array and were rendered with `String(value)`, so a
 * PNG stored in a MEDIUMBLOB showed as `137,80,78,71,13,10,26,10,…` — the
 * bytes, comma-separated, all of them. That is not a preview of anything
 * (#401).
 *
 * FR-3.1.9 asks for size, type, and a preview: image, hex, and a text attempt.
 * The type comes from the bytes themselves rather than from a column comment
 * or a filename, because neither is present in a result set.
 */

/**
 * True when a cell actually arrived as bytes.
 *
 * Keyed on the value rather than on the declared column type: a `SELECT
 * UNHEX(...)` has no declared type to read, and the backend already decided
 * what is binary when it built the row.
 */
export function isBytes(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((b) => typeof b === "number");
}

const UNITS = ["B", "KB", "MB", "GB"];

/** A byte count someone can read at a glance. */
export function formatBytes(length: number): string {
  let size = length;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit++;
  }
  // Whole bytes stay whole; anything scaled keeps one decimal, which is as
  // much precision as the unit is worth.
  return unit === 0 ? `${size} ${UNITS[0]}` : `${size.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * Magic-byte signatures, longest first so a prefix cannot win over a longer
 * match.
 *
 * Only formats a browser will actually render are listed. Claiming a MIME
 * type the `<img>` cannot display would offer an image tab that shows a
 * broken icon, which is worse than not offering one.
 */
const SIGNATURES: { mime: string; bytes: number[]; offset?: number }[] = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/bmp", bytes: [0x42, 0x4d] },
  // RIFF....WEBP — the four size bytes in between are not part of the match.
  { mime: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { mime: "image/x-icon", bytes: [0x00, 0x00, 0x01, 0x00] },
];

/** An SVG is text, so it is recognised by its root element rather than by bytes. */
const SVG_START = /^\s*(<\?xml[^>]*\?>\s*)?(<!--.*?-->\s*)*<svg[\s>]/is;

/**
 * What these bytes are, or null when nothing recognises them.
 *
 * Used only to decide whether to offer an image preview.
 */
export function detectMime(bytes: number[]): string | null {
  for (const sig of SIGNATURES) {
    const at = sig.offset ?? 0;
    if (bytes.length < at + sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => bytes[at + i] === b)) return sig.mime;
  }
  // An SVG has no magic number; check the start of it as text.
  if (SVG_START.test(decodeUtf8(bytes.slice(0, 256)))) return "image/svg+xml";
  return null;
}

/**
 * Best-effort UTF-8.
 *
 * `fatal: false` on purpose: a BLOB that is mostly text with one stray byte
 * should still be readable, with U+FFFD marking where it went wrong, rather
 * than refusing to decode at all.
 */
export function decodeUtf8(bytes: number[]): string {
  try {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  } catch {
    return "";
  }
}

/**
 * True when the bytes look like text worth showing as text.
 *
 * Control characters other than tab, newline and carriage return are the
 * giveaway: they do not occur in text and are everywhere in compiled data.
 */
export function looksLikeText(bytes: number[]): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.slice(0, 1024);
  const control = sample.filter((b) => b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f);
  return control.length / sample.length < 0.05;
}

/** How many bytes one line of the hex dump covers. */
export const HEX_COLUMNS = 16;

export interface HexLine {
  /** Byte offset of the first byte on this line. */
  offset: number;
  /** Two hex digits per byte, padded to a full line so columns stay aligned. */
  hex: string;
  /** The same bytes as printable ASCII, with `.` standing in for the rest. */
  ascii: string;
}

/**
 * A classic hex dump: offset, 16 bytes, then the printable rendering.
 *
 * `limit` exists because a 50 MB BLOB is 3.2 million lines, and building them
 * all to show the first screenful would lock the window up.
 */
export function hexDump(bytes: number[], limit = 4096): HexLine[] {
  const lines: HexLine[] = [];
  const end = Math.min(bytes.length, limit);
  for (let offset = 0; offset < end; offset += HEX_COLUMNS) {
    const slice = bytes.slice(offset, offset + HEX_COLUMNS);
    lines.push({
      offset,
      hex: slice
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")
        .padEnd(HEX_COLUMNS * 3 - 1, " "),
      ascii: slice.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join(""),
    });
  }
  return lines;
}

/** A data: URI the browser can render, for bytes a MIME type was found for. */
export function dataUri(bytes: number[], mime: string): string {
  let binary = "";
  // Chunked: spreading a multi-megabyte array into apply() overflows the
  // call stack.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.slice(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** What the grid cell shows in place of the bytes. */
export function describeBlob(bytes: number[]): string {
  const mime = detectMime(bytes);
  const size = formatBytes(bytes.length);
  return mime ? `${mime}, ${size}` : `BLOB, ${size}`;
}
