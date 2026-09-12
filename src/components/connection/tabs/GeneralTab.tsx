import type { ConnectionProfileInput } from "../../../types";
import { Field } from "../../common/Field";

/** The colours a connection can be tagged with (FR-1.2.5). */
export const PRESET_COLORS = [
  "#3B82F6",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#F97316",
];

interface GeneralTabProps {
  form: ConnectionProfileInput;
  /**
   * Whether this is an existing profile.
   *
   * Only the password placeholder needs it: a saved profile's password is
   * never sent back, so an empty box means "keep the stored one" rather than
   * "no password", and the field says so.
   */
  isExisting: boolean;
  onChange: (
    field: keyof ConnectionProfileInput,
    value: string | number | boolean | undefined,
  ) => void;
}

/** Where the server is, and who to be when talking to it. */
export function GeneralTab({ form, isExisting, onChange: handleChange }: GeneralTabProps) {
  return (
    <div className="space-y-3">
      <Field
        label="Name"
        value={form.name}
        onChange={(v) => handleChange("name", v)}
        placeholder="My Database"
      />
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Field
            label="Host"
            value={form.host}
            onChange={(v) => handleChange("host", v)}
          />
        </div>
        <Field
          label="Port"
          value={String(form.port)}
          onChange={(v) => handleChange("port", parseInt(v) || 3306)}
          type="number"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Username"
          value={form.username}
          onChange={(v) => handleChange("username", v)}
        />
        <Field
          label="Password"
          value={form.password ?? ""}
          onChange={(v) => handleChange("password", v)}
          type="password"
          placeholder={isExisting && !form.password ? "Saved (leave blank to keep)" : undefined}
        />
      </div>
      <Field
        label="Default Database"
        value={form.default_database || ""}
        onChange={(v) => handleChange("default_database", v)}
        placeholder="(optional)"
      />
      {/* Color picker */}
      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Color
        </label>
        <div className="flex items-center gap-1.5">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => handleChange("color", c)}
              className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
                form.color === c
                  ? "border-[var(--color-text-primary)] scale-110"
                  : "border-transparent"
              }`}
              style={{ backgroundColor: c }}
              title={c}
            />
          ))}
          {form.color && (
            <button
              type="button"
              onClick={() => handleChange("color", "")}
              className="ml-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      {/* Environment */}
      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Environment
        </label>
        <select
          value={form.environment ?? ""}
          onChange={(e) =>
            handleChange(
              "environment",
              e.target.value || undefined,
            )}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-brand-500"
        >
          <option value="">None</option>
          <option value="development">Development</option>
          <option value="staging">Staging</option>
          <option value="production">Production</option>
        </select>
      </div>
    </div>
  );
}
