import { Pipette } from "lucide-react";
import { useRef } from "react";
import { cn } from "../../lib/utils";

/** The colours a connection can be tagged with (FR-1.2.5), by the name a person would use. */
export const PRESET_COLORS: { value: string; name: string }[] = [
  { value: "#3B82F6", name: "Blue" },
  { value: "#10B981", name: "Green" },
  { value: "#F59E0B", name: "Amber" },
  { value: "#EF4444", name: "Red" },
  { value: "#8B5CF6", name: "Violet" },
  { value: "#EC4899", name: "Pink" },
  { value: "#06B6D4", name: "Cyan" },
  { value: "#F97316", name: "Orange" },
];

const sameColor = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** A selected swatch gets a ring with a gap, so it reads on any swatch colour and any theme. */
const SELECTED = "ring-2 ring-[var(--color-text-primary)] ring-offset-2 ring-offset-[var(--color-bg-secondary)]";

interface ColorPickerProps {
  value: string | null | undefined;
  onChange: (color: string) => void;
  /** Id of the element that labels the group. */
  labelledBy: string;
}

/**
 * Eight presets and a custom colour (FR-1.2.5, #834).
 *
 * The custom colour was promised and not built, so a profile saved with any
 * other colour showed no swatch selected and could not be re-picked. Presets
 * also compared case-sensitively, so "#f59e0b" did not match Amber.
 */
export function ColorPicker({ value, onChange, labelledBy }: ColorPickerProps) {
  const customInput = useRef<HTMLInputElement>(null);
  const isPreset = PRESET_COLORS.some((c) => sameColor(value, c.value));
  const isCustom = !!value && !isPreset;

  return (
    <div role="group" aria-labelledby={labelledBy} className="flex items-center gap-1.5">
      {PRESET_COLORS.map((c) => {
        const selected = sameColor(value, c.value);
        return (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange(c.value)}
            aria-pressed={selected}
            aria-label={c.name}
            title={c.name}
            className={cn(
              "h-6 w-6 rounded-full transition-transform hover:scale-110",
              selected && SELECTED,
            )}
            style={{ backgroundColor: c.value }}
          />
        );
      })}
      <button
        type="button"
        onClick={() => customInput.current?.click()}
        aria-pressed={isCustom}
        aria-label={isCustom ? `Custom colour, ${value}` : "Custom colour"}
        title={isCustom ? `Custom (${value})` : "Custom colour…"}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-full transition-transform hover:scale-110",
          isCustom ? SELECTED : "border border-dashed border-[var(--color-text-muted)]",
        )}
        style={isCustom && value ? { backgroundColor: value } : undefined}
      >
        {!isCustom && <Pipette className="h-3 w-3 text-[var(--color-text-muted)]" />}
      </button>
      <input
        ref={customInput}
        type="color"
        // The native picker wants #rrggbb; anything else opens on black.
        value={value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "#000000"}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Custom colour value"
        tabIndex={-1}
        className="sr-only"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="ml-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          Clear
        </button>
      )}
    </div>
  );
}
