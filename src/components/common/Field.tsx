/**
 * A labelled input, with room to say what is wrong with what was typed.
 *
 * Lived inside `ConnectionDialog` while it was the only user (#275). The
 * label is tied to the input by id, so a test — and a screen reader — can
 * find the field by its name rather than by position.
 */
export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  problem,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  /** Why this value cannot be saved, if it cannot. */
  problem?: string;
  /** What the field is for, when the label is not enough. */
  hint?: string;
}) {
  const id = `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={problem !== undefined}
        aria-describedby={problem ? `${id}-problem` : hint ? `${id}-hint` : undefined}
        className={`w-full rounded border bg-[var(--color-bg-primary)] px-2.5 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-brand-500 ${
          problem ? "border-red-500/60" : "border-[var(--color-border)]"
        }`}
      />
      {problem
        ? <p id={`${id}-problem`} className="mt-0.5 text-[10px] text-red-400">{problem}</p>
        : hint
        ? <p id={`${id}-hint`} className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{hint}</p>
        : null}
    </div>
  );
}
