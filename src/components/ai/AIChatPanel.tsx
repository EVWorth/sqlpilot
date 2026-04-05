import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Plus,
  Loader2,
  X,
  Circle,
  Sparkles,
} from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { ChatMessageComponent } from "./ChatMessage";
import { NLToSQLInput } from "./NLToSQLInput";

interface AIChatPanelProps {
  onClose: () => void;
}

export function AIChatPanel({ onClose }: AIChatPanelProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const status = useAiStore((s) => s.status);
  const isStreaming = useAiStore((s) => s.isStreaming);
  const conversations = useAiStore((s) => s.conversations);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const streamingContent = useAiStore((s) => s.streamingContent);
  const sendMessage = useAiStore((s) => s.sendMessage);
  const newConversation = useAiStore((s) => s.newConversation);
  const checkStatus = useAiStore((s) => s.checkStatus);

  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const activeConnection = activeConnections.find(
    (c) => c.id === selectedConnectionId,
  );

  const activeConversation = conversations.find(
    (c) => c.id === activeConversationId,
  );

  // Check status on mount
  useEffect(() => {
    checkStatus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages, streamingContent]);

  const handleSend = useCallback(async () => {
    const msg = input.trim();
    if (!msg || isStreaming) return;
    setInput("");
    await sendMessage(msg, selectedConnectionId ?? undefined, activeConnection?.database ?? undefined);
  }, [input, isStreaming, sendMessage, selectedConnectionId, activeConnection]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleNewChat = useCallback(() => {
    newConversation();
    setInput("");
    inputRef.current?.focus();
  }, [newConversation]);

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-400" />
          <span className="text-xs font-semibold text-[var(--color-text-primary)]">
            AI Assistant
          </span>
          {status && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
              <Circle
                className={`h-1.5 w-1.5 fill-current ${status.available ? "text-green-400" : "text-red-400"}`}
              />
              {status.available
                ? status.model ?? status.provider
                : "Unavailable"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleNewChat}
            title="New Chat"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClose}
            title="Close AI Panel"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* NL to SQL quick bar */}
      <NLToSQLInput />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {!activeConversation || activeConversation.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Sparkles className="h-8 w-8 text-[var(--color-text-muted)] opacity-30" />
            <p className="text-xs text-[var(--color-text-muted)]">
              Ask a question about your database, get SQL help, or explain
              queries.
            </p>
            {activeConnection && (
              <p className="text-[10px] text-[var(--color-text-muted)]">
                Connected to{" "}
                <span className="text-brand-400">
                  {activeConnection.name}
                </span>
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {activeConversation.messages.map((msg, i) => (
              <ChatMessageComponent
                key={i}
                role={msg.role}
                content={msg.content}
              />
            ))}
            {/* Streaming indicator */}
            {isStreaming && streamingContent && (
              <ChatMessageComponent
                role="assistant"
                content={streamingContent}
              />
            )}
            {isStreaming && !streamingContent && (
              <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                Thinking...
              </div>
            )}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2">
        <div className="flex items-end gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-1.5">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your database..."
            rows={1}
            className="flex-1 resize-none bg-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
            style={{ maxHeight: "80px" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            title="Send (Enter)"
            className="rounded p-1 text-brand-400 hover:bg-brand-600/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isStreaming ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <p className="mt-1 text-[9px] text-[var(--color-text-muted)]">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
