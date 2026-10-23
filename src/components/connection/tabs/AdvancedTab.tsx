import type { ConnectionProfileInput } from "../../../types";
import { Field } from "../../common/Field";
import type { NumberField } from "../useConnectionForm";

interface AdvancedTabProps {
  form: ConnectionProfileInput;
  onChange: (
    field: keyof ConnectionProfileInput,
    value: string | number | boolean | undefined,
  ) => void;
  /** What is typed in the number fields, which may not parse yet (#813). */
  numberText: Record<NumberField, string>;
  numberProblems: Partial<Record<NumberField, string>>;
  onNumberChange: (field: NumberField, text: string) => void;
}

/**
 * Timeouts and the read-only switch.
 *
 * There is no pool sizing here any more: each editor tab, agent session and
 * backup has a connection of its own, and what is left is a small fixed set
 * for schema browsing (#731). No other client asks its users to size a pool.
 */
export function AdvancedTab({
  form,
  onChange: handleChange,
  numberText,
  numberProblems,
  onNumberChange,
}: AdvancedTabProps) {
  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={form.read_only}
          onChange={(e) => handleChange("read_only", e.target.checked)}
          className="h-3.5 w-3.5 rounded border-[var(--color-border)] accent-brand-500"
        />
        <span className="text-xs font-medium text-[var(--color-text-primary)]">
          Read-only mode
        </span>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Connect Timeout (s)"
          value={numberText.connect_timeout_secs}
          onChange={(v) => onNumberChange("connect_timeout_secs", v)}
          problem={numberProblems.connect_timeout_secs}
          type="number"
          placeholder="10"
        />
        <Field
          label="Query Timeout (s, 0=unlimited)"
          value={numberText.query_timeout_secs}
          onChange={(v) => onNumberChange("query_timeout_secs", v)}
          problem={numberProblems.query_timeout_secs}
          type="number"
          placeholder="0"
        />
      </div>
      <Field
        label="Character Set"
        value={form.charset ?? "utf8mb4"}
        onChange={(v) => handleChange("charset", v || "utf8mb4")}
        placeholder="utf8mb4"
      />
    </div>
  );
}
