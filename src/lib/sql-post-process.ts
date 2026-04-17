/**
 * Post-process formatted SQL to apply identifier casing rules:
 *
 * 1. Backtick-quoted identifiers → lowercase  (`YEAR` → `year`)
 * 2. Dot-qualified uppercase identifiers → lowercase  (cars.YEAR → cars.year)
 *
 * These rules let keyword-like column names (e.g. YEAR) appear uppercased
 * when bare (formatter treats them as keywords), but correctly lowercased
 * when context makes it clear they're identifiers.
 */
export function postProcessSQL(sql: string): string {
  // Split on single-quoted string literals so we don't mutate string values.
  // Tokens alternate: [non-string, string, non-string, string, ...]
  const tokens = sql.split(/(\'(?:[^\'\\]|\\[\s\S])*\')/);

  return tokens
    .map((token, i) => {
      if (i % 2 === 1) return token; // inside a string literal — leave untouched

      // Rule 1: lowercase content inside backticks
      let result = token.replace(/`([^`]+)`/g, (_, inner) => '`' + inner.toLowerCase() + '`');

      // Rule 2: dot-qualified all-uppercase identifiers → lowercase
      // Matches: identifier.UPPERCASE_WORD  (right side must be all caps to be keyword-like)
      result = result.replace(
        /(\w+)\.([A-Z][A-Z0-9_]*)\b/g,
        (_, qualifier, ident) => qualifier + '.' + ident.toLowerCase(),
      );

      return result;
    })
    .join('');
}
