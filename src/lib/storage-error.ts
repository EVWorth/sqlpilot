/**
 * Convert a caught `localStorage.setItem` exception into a short, user-facing
 * description. Distinguishes QuotaExceededError from a blocked-storage
 * SecurityError so the message can suggest "clear space" vs "check private
 * mode" rather than leaking a raw DOMException at the user.
 */
export function describeStorageError(e: unknown, label: string): string {
  if (e instanceof DOMException && (e.name === "QuotaExceededError" || e.code === 22)) {
    return `Could not save ${label}: browser storage quota exceeded. Clear site data or free up space, then re-save.`;
  }
  if (e instanceof DOMException && (e.name === "SecurityError" || e.code === 18)) {
    return `Could not save ${label}: browser storage access blocked (private mode or disabled cookies).`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return `Could not save ${label}: ${msg}`;
}
