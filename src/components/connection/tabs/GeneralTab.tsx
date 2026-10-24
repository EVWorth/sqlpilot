import type { ConnectionProfileInput } from "../../../types";
import { Field } from "../../common/Field";
import { ColorPicker } from "../ColorPicker";
import type { NumberField } from "../useConnectionForm";

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
  /** What is typed in the number fields, which may not parse yet (#813). */
  numberText: Record<NumberField, string>;
  numberProblems: Partial<Record<NumberField, string>>;
  onNumberChange: (field: NumberField, text: string) => void;
  /** The Name input, which the dialog focuses on open (#832). */
  nameRef?: React.Ref<HTMLInputElement>;
}

/** Where the server is, and who to be when talking to it. */
export function GeneralTab({
  form,
  isExisting,
  onChange: handleChange,
  numberText,
  numberProblems,
  onNumberChange,
  nameRef,
}: GeneralTabProps) {
  return (
    <div className="space-y-3">
      <Field
        label="Name"
        value={form.name}
        onChange={(v) => handleChange("name", v)}
        placeholder="My Database"
        inputRef={nameRef}
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
          value={numberText.port}
          onChange={(v) => onNumberChange("port", v)}
          problem={numberProblems.port}
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
      <div>
        <span
          id="connection-color-label"
          className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"
        >
          Color
        </span>
        <ColorPicker
          value={form.color}
          onChange={(color) => handleChange("color", color)}
          labelledBy="connection-color-label"
        />
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
