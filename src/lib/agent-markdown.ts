/**
 * The little markdown agents write, as blocks the panel can render.
 *
 * Agents answer in markdown whether asked to or not: lists, `inline code` and
 * fenced SQL. Shown raw, the answer reads as punctuation. A full renderer is a
 * dependency and an HTML surface this does not need, so this handles the few
 * constructs that actually turn up and leaves everything else as text. Nothing
 * here produces HTML; the component builds React nodes from the result.
 *
 * Text arrives a delta at a time, so an unclosed fence is a block still being
 * written: it renders as code up to where the text ends.
 */

export type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language: string; text: string };

export type Span =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string };

const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split("\n");
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", language: fence[1] ?? "", text: code.join("\n") });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flush();
      const ordered = numbered !== null;
      const previous = blocks[blocks.length - 1];
      if (previous?.type === "list" && previous.ordered === ordered) {
        previous.items.push(item[1] ?? "");
      } else {
        blocks.push({ type: "list", ordered, items: [item[1] ?? ""] });
      }
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", text: heading[1] ?? "" });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** `code` and **bold** inside a line; anything else stays text. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > at) spans.push({ type: "text", text: text.slice(at, index) });
    if (match[1] !== undefined) spans.push({ type: "code", text: match[1] });
    else spans.push({ type: "strong", text: match[2] ?? "" });
    at = index + match[0].length;
  }
  if (at < text.length) spans.push({ type: "text", text: text.slice(at) });
  return spans;
}
