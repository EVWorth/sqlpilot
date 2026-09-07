/**
 * Whether a foreign key's columns could actually reference what they name.
 *
 * MySQL checks this itself and answers a mismatch with
 * `ERROR 1215 (HY000): Cannot add foreign key constraint` — a message that
 * says nothing about which column or why. The editor let any local column be
 * pointed at any referenced column, so the first sign was that error at save
 * time (#385).
 *
 * This is a warning, not a gate. The real rules take in storage engine,
 * character set, index coverage and signedness, and a check that refuses more
 * than the server would is worse than one that occasionally lets something
 * through. What is caught here is the mismatch that is never valid: a
 * different type family.
 */

/** The families MySQL will match within, but not across. */
const FAMILIES: Record<string, string> = {};
for (const t of ["TINYINT", "SMALLINT", "MEDIUMINT", "INT", "INTEGER", "BIGINT", "SERIAL"]) {
  FAMILIES[t] = "integer";
}
for (const t of ["DECIMAL", "NUMERIC", "FLOAT", "DOUBLE", "REAL"]) FAMILIES[t] = "decimal";
for (const t of ["CHAR", "VARCHAR", "TEXT", "TINYTEXT", "MEDIUMTEXT", "LONGTEXT"]) {
  FAMILIES[t] = "text";
}
for (const t of ["BINARY", "VARBINARY", "BLOB", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB"]) {
  FAMILIES[t] = "binary";
}
for (const t of ["DATE", "DATETIME", "TIMESTAMP", "TIME", "YEAR"]) FAMILIES[t] = "temporal";

function familyOf(type: string): string | null {
  const base = type.trim().toUpperCase().replace(/\(.*$/, "").split(/\s+/)[0];
  return FAMILIES[base] ?? null;
}

/**
 * A sentence naming the problem, or null when there is nothing to say.
 *
 * Silence covers both "these match" and "this build cannot tell" — an
 * unrecognised type on either side produces no claim rather than a guess.
 */
export function foreignKeyTypeProblem(
  localType: string | undefined,
  referencedType: string | undefined,
): string | null {
  if (!localType || !referencedType) return null;

  const local = familyOf(localType);
  const referenced = familyOf(referencedType);
  if (!local || !referenced) return null;
  if (local === referenced) return null;

  return `${localType} cannot reference ${referencedType}: MySQL requires both sides of a `
    + `foreign key to be the same kind of type.`;
}
