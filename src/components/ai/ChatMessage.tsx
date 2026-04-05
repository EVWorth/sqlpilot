import { useState, useCallback } from "react";
import { Copy, Check, Play, FileInput, Sparkles } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { ToolCallBlock } from "./ToolCallBlock";
import type { ToolExecution, MessageSegment } from "../../types";

interface ChatMessageProps {
  role: "system" | "user" | "assistant";
  content: string;
  toolCalls?: ToolExecution[];
  segments?: MessageSegment[];
}

interface CodeBlock {
  type: "text" | "sql" | "code";
  content: string;
  language?: string;
}

function parseContent(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Text before code block
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index);
      if (text.trim()) {
        blocks.push({ type: "text", content: text });
      }
    }

    const language = match[1].toLowerCase() || "";
    const code = match[2].trimEnd();
    blocks.push({
      type: language === "sql" || language === "mysql" ? "sql" : "code",
      content: code,
      language: language || undefined,
    });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex);
    if (remaining.trim()) {
      blocks.push({ type: "text", content: remaining });
    }
  }

  // If no blocks were found, treat entire content as text
  if (blocks.length === 0) {
    blocks.push({ type: "text", content });
  }

  return blocks;
}

function SqlCodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const handleInsert = useCallback(() => {
    const editor = useEditorStore.getState().editorInstance;
    if (editor) {
      const position = editor.getPosition();
      if (position) {
        editor.executeEdits("ai-insert", [
          {
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
            text: code + "\n",
          },
        ]);
        editor.focus();
      }
    }
  }, [code]);

  const handleRun = useCallback(() => {
    const connectionId =
      useConnectionStore.getState().selectedConnectionId;
    if (!connectionId || !code.trim()) return;
    useResultStore.getState().executeQuery(connectionId, code);
  }, [code]);

  const connectionId = useConnectionStore((s) => s.selectedConnectionId);

  return (
    <div className="group relative my-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-2 py-0.5">
        <span className="text-[10px] font-medium uppercase text-[var(--color-text-muted)]">
          SQL
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleInsert}
            title="Insert into editor"
            className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <FileInput className="h-3 w-3" />
          </button>
          <button
            onClick={handleCopy}
            title="Copy"
            className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-400" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
          {connectionId && (
            <button
              onClick={handleRun}
              title="Run query"
              className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-green-400"
            >
              <Play className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <pre className="overflow-x-auto p-2 text-xs leading-relaxed text-[var(--color-text-primary)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function ChatMessageComponent({ role, content, toolCalls, segments }: ChatMessageProps) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-brand-600 px-3 py-2 text-xs leading-relaxed text-white">
          <p className="whitespace-pre-wrap">{content}</p>
        </div>
      </div>
    );
  }

  // If we have ordered segments, render them inline
  if (segments && segments.length > 0) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[95%] rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-2 text-xs leading-relaxed text-[var(--color-text-primary)]">
          {segments.map((seg, i) => {
            switch (seg.type) {
              case "intent":
                return (
                  <div key={`intent-${i}`} className="flex items-center gap-1.5 text-[10px] text-brand-400 italic my-1">
                    <Sparkles className="h-3 w-3 shrink-0" />
                    {seg.intent}
                  </div>
                );
              case "tool":
                return <ToolCallBlock key={seg.tool.id} tool={seg.tool} />;
              case "text": {
                const blocks = parseContent(seg.content);
                return (
                  <div key={`text-${i}`}>
                    {blocks.map((block, j) => {
                      if (block.type === "sql") {
                        return <SqlCodeBlock key={j} code={block.content} />;
                      }
                      if (block.type === "code") {
                        return (
                          <pre key={j} className="my-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2 text-xs">
                            <code>{block.content}</code>
                          </pre>
                        );
                      }
                      return <p key={j} className="whitespace-pre-wrap">{block.content}</p>;
                    })}
                  </div>
                );
              }
            }
          })}
        </div>
      </div>
    );
  }

  // Legacy fallback: content + toolCalls
  const blocks = parseContent(content);

  return (
    <div className="flex justify-start">
      <div className="max-w-[95%] rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-2 text-xs leading-relaxed text-[var(--color-text-primary)]">
        {/* Tool calls rendered before text */}
        {toolCalls && toolCalls.length > 0 && (
          <div className="mb-2">
            {toolCalls.map((tool) => (
              <ToolCallBlock key={tool.id} tool={tool} />
            ))}
          </div>
        )}
        {blocks.map((block, i) => {
          if (block.type === "sql") {
            return <SqlCodeBlock key={i} code={block.content} />;
          }
          if (block.type === "code") {
            return (
              <pre
                key={i}
                className="my-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2 text-xs"
              >
                <code>{block.content}</code>
              </pre>
            );
          }
          return (
            <p key={i} className="whitespace-pre-wrap">
              {block.content}
            </p>
          );
        })}
      </div>
    </div>
  );
}
