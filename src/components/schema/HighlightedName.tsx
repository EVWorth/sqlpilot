/**
 * An object name with the filter's match picked out.
 *
 * FR-4.1.3 asks for the matching text to be highlighted, and the filter only
 * narrowed the list (#296). With a filter like `user` that matches `users`,
 * `user_roles` and `audit_user`, knowing *where* it matched is most of what
 * tells you which one you wanted.
 */
export function HighlightedName({ name, match }: { name: string; match: string }) {
  const needle = match.trim().toLowerCase();
  if (!needle) return <>{name}</>;

  const at = name.toLowerCase().indexOf(needle);
  if (at < 0) return <>{name}</>;

  return (
    <>
      {name.slice(0, at)}
      <mark className="bg-brand-500/30 text-[var(--color-text-primary)]">
        {
          /* Sliced from the original rather than rendering the needle, so the
            name's own casing survives being matched case-insensitively. */
        }
        {name.slice(at, at + needle.length)}
      </mark>
      {name.slice(at + needle.length)}
    </>
  );
}
