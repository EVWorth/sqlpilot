interface Props {
  value: unknown;
  columnName: string;
  onViewFull: (content: string | null, columnName: string) => void;
}

const MAX_DISPLAY_LENGTH = 50;
const TRUNCATE_LENGTH = 47; // Leaves room for "..."

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "string") return val;
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  return String(val);
}

function shouldTruncate(val: unknown): boolean {
  if (val === null || val === undefined) return false;
  const formatted = formatValue(val);
  return formatted.length > MAX_DISPLAY_LENGTH;
}

function getTruncatedDisplay(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  const formatted = formatValue(val);
  if (formatted.length > MAX_DISPLAY_LENGTH) {
    return formatted.slice(0, TRUNCATE_LENGTH) + "...";
  }
  return formatted;
}

export function TruncatedCell({
  value,
  columnName,
  onViewFull,
}: Props) {
  const isTruncated = shouldTruncate(value);
  const displayText = getTruncatedDisplay(value);

  return (
    <div
      className={isTruncated ? "cursor-pointer hover:underline" : ""}
      onDoubleClick={() => {
        if (isTruncated) {
          onViewFull(value === null || value === undefined ? null : formatValue(value), columnName);
        }
      }}
      title={isTruncated ? "Double-click to view full content" : ""}
    >
      {displayText}
    </div>
  );
}
