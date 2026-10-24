/**
 * Bounds for a date the user picked in an `<input type="date">`.
 *
 * The input gives a calendar day in the user's own time zone. Gluing
 * `T00:00:00Z` onto it made a UTC day instead, so outside UTC the range was
 * shifted by the offset: in UTC-7 "from Oct 21" took in the evening of Oct 20
 * and dropped the evening of Oct 21 (#836). These build local midnight and
 * local end of day and hand them over as UTC instants, which is how
 * timestamps are stored.
 */

function parseYmd(ymd: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Local midnight at the start of `ymd`, as an ISO instant. "" if invalid. */
export function localDayStart(ymd: string): string {
  const parts = parseYmd(ymd);
  if (!parts) return "";
  const [y, m, d] = parts;
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** The last millisecond of `ymd`, local time, as an ISO instant. "" if invalid. */
export function localDayEnd(ymd: string): string {
  const parts = parseYmd(ymd);
  if (!parts) return "";
  const [y, m, d] = parts;
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

/** The local calendar day an ISO instant falls on, for a date input. */
export function toLocalYmd(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
