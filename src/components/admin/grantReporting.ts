/**
 * Saying what a partly-applied privilege change actually did.
 *
 * Grants and revokes are separate statements and commit as they run, so an
 * interrupted change leaves the server in a state neither the old nor the new
 * one. Reporting that precisely is the difference between an admin who knows
 * what to fix and one who has to go and look.
 */

export function describePartialFailure(
  statements: string[],
  applied: string[],
  error: unknown,
): string {
  const failed = statements[applied.length];
  const notAttempted = statements.slice(applied.length + 1);

  const lines = [
    `Applied ${applied.length} of ${statements.length} statements, then failed.`,
    "",
    `Failed: ${failed}`,
    `  ${String(error)}`,
  ];
  if (applied.length > 0) {
    lines.push("", "Already applied (GRANT and REVOKE cannot be rolled back):");
    lines.push(...applied.map((s) => `  ${s}`));
  }
  if (notAttempted.length > 0) {
    lines.push("", "Not attempted:");
    lines.push(...notAttempted.map((s) => `  ${s}`));
  }
  lines.push("", "The privilege list has been refreshed from the server.");
  return lines.join("\n");
}

export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
