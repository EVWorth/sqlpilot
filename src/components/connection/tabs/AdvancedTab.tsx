import { POOL_MAX_LIMIT, type PoolProblems } from "../../../lib/connection-validation";
import type { ConnectionProfileInput } from "../../../types";
import { Field } from "../../common/Field";

interface AdvancedTabProps {
  form: ConnectionProfileInput;
  onChange: (
    field: keyof ConnectionProfileInput,
    value: string | number | boolean | undefined,
  ) => void;
  /** What is wrong with the pool sizing, if anything (#279). */
  poolProblems: PoolProblems;
}

/** Pool sizing, timeouts, and the read-only switch. */
export function AdvancedTab({ form, onChange: handleChange, poolProblems }: AdvancedTabProps) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Pool Min Connections"
          value={String(form.pool_min)}
          onChange={(v) => handleChange("pool_min", parseInt(v) || 0)}
          type="number"
          problem={poolProblems.min}
          hint="Opened up front. 0 opens them as they are needed."
        />
        <Field
          label="Pool Max Connections"
          value={String(form.pool_max)}
          onChange={(v) => handleChange("pool_max", parseInt(v) || 1)}
          type="number"
          problem={poolProblems.max}
          hint={`How many queries can run at once. 1–${POOL_MAX_LIMIT}.`}
        />
      </div>
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
