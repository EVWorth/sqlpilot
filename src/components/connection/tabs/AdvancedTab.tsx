import type { ConnectionProfileInput } from "../../../types";
import { Field } from "../../common/Field";

interface AdvancedTabProps {
  form: ConnectionProfileInput;
  onChange: (
    field: keyof ConnectionProfileInput,
    value: string | number | boolean | undefined,
  ) => void;
}

/**
 * Timeouts and the read-only switch.
 *
 * There is no pool sizing here any more: each editor tab, agent session and
 * backup has a connection of its own, and what is left is a small fixed set
 * for schema browsing (#731). No other client asks its users to size a pool.
 */
export function AdvancedTab({ form, onChange: handleChange }: AdvancedTabProps) {
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
          value={String(form.connect_timeout_secs ?? 10)}
          onChange={(v) => handleChange("connect_timeout_secs", parseInt(v) || 10)}
          type="number"
          placeholder="10"
        />
        <Field
          label="Query Timeout (s, 0=unlimited)"
          value={String(form.query_timeout_secs ?? 0)}
          onChange={(v) => handleChange("query_timeout_secs", parseInt(v) || 0)}
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
