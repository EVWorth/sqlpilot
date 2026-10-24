import { parseBlocks, parseInline } from "../../lib/agent-markdown";

/** One line of agent text, with its `code` and **bold** rendered. */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((span, i) =>
        span.type === "code"
          ? (
            <code
              key={i}
              className="rounded bg-[var(--color-bg-tertiary)] px-1 font-mono text-[11px] text-[var(--color-text-primary)]"
            >
              {span.text}
            </code>
          )
          : span.type === "strong"
          ? <strong key={i} className="font-semibold">{span.text}</strong>
          : <span key={i}>{span.text}</span>
      )}
    </>
  );
}

/** An agent's answer: paragraphs, lists and code, never raw HTML. */
export function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="space-y-1.5 text-xs text-[var(--color-text-primary)]">
      {parseBlocks(text).map((block, i) => {
        switch (block.type) {
          case "paragraph":
            return (
              <p key={i} className="whitespace-pre-wrap break-words">
                <Inline text={block.text} />
              </p>
            );
          case "heading":
            return (
              <p key={i} className="font-semibold">
                <Inline text={block.text} />
              </p>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={i} className={block.ordered ? "list-decimal space-y-0.5 pl-5" : "list-disc space-y-0.5 pl-5"}>
                {block.items.map((item, j) => (
                  <li key={j} className="break-words">
                    <Inline text={item} />
                  </li>
                ))}
              </List>
            );
          }
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded bg-[var(--color-bg-secondary)] p-2 font-mono text-[11px] text-[var(--color-text-primary)]"
              >
                {block.text}
              </pre>
            );
        }
      })}
    </div>
  );
}
