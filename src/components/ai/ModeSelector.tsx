import type { AiMode } from "../../types";

const modes: { value: AiMode; label: string; description: string }[] = [
  { value: "ask", label: "Ask", description: "Read-only questions" },
  { value: "agent", label: "Agent", description: "Can modify data" },
  { value: "plan", label: "Plan", description: "Plan then execute" },
];

interface ModeSelectorProps {
  value: AiMode;
  onChange: (mode: AiMode) => void;
  disabled?: boolean;
}

export function ModeSelector({ value, onChange, disabled }: ModeSelectorProps) {
  return (
    <div className="flex rounded-md border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-0.5">
      {modes.map((m) => (
        <button
          key={m.value}
          onClick={() => onChange(m.value)}
          disabled={disabled}
          title={m.description}
          className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
            value === m.value
              ? "bg-brand-600 text-white"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
