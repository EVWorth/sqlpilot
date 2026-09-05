import type { TableOptions } from "./ddl-generator";

/**
 * Reading a table's real options out of SHOW CREATE TABLE.
 *
 * The designer used to open every table showing InnoDB / utf8mb4 /
 * utf8mb4_general_ci and an empty comment, because both the form state and
 * the diff baseline were initialised from the same hardcoded defaults. Two
 * consequences, and the second is the damaging one:
 *
 *   - the Options tab misreported what the table actually is
 *   - a change *towards* a default was silently discarded. Selecting InnoDB
 *     for a MyISAM table compares the new value against a baseline that
 *     already said InnoDB, so the diff is empty and the user is told
 *     "No changes detected" (#378).
 *
 * MySQL 8 and MariaDB 11 both emit the same trailing line, verified against
 * each:
 *
 *   ) ENGINE=MyISAM AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb3 \
 *     COLLATE=utf8mb3_bin COMMENT='legacy o''brien'
 *
 * Note the comment quoting: a single quote is doubled, not backslashed.
 */

/** The defaults a brand-new table starts from. */
export const DEFAULT_TABLE_OPTIONS: TableOptions = {
  engine: "InnoDB",
  charset: "utf8mb4",
  collation: "utf8mb4_general_ci",
  autoIncrementStart: "1",
  comment: "",
};

/**
 * The trailing options, which begin at the `)` that closes the column list.
 *
 * Found from the end rather than the start: a column comment can contain
 * anything, including a newline followed by a bracket.
 */
function optionsClause(ddl: string): string {
  const idx = ddl.lastIndexOf("\n)");
  return idx === -1 ? "" : ddl.slice(idx + 2);
}

/** Undo the doubling MySQL applies inside a quoted option value. */
function unquote(raw: string): string {
  return raw.replace(/''/g, "'");
}

/**
 * Read what the server says the table is. Anything absent from the DDL keeps
 * its default — a table created without an explicit COLLATE, for instance,
 * simply has no COLLATE in its SHOW CREATE TABLE output.
 */
export function parseTableOptions(ddl: string): TableOptions {
  const clause = optionsClause(ddl);
  const opts: TableOptions = { ...DEFAULT_TABLE_OPTIONS };
  if (!clause) return opts;

  const engine = /\bENGINE=(\w+)/i.exec(clause);
  if (engine) opts.engine = engine[1];

  const charset = /\bDEFAULT\s+CHARSET=(\w+)/i.exec(clause);
  if (charset) opts.charset = charset[1];

  const collation = /\bCOLLATE=(\w+)/i.exec(clause);
  if (collation) opts.collation = collation[1];

  const autoInc = /\bAUTO_INCREMENT=(\d+)/i.exec(clause);
  if (autoInc) opts.autoIncrementStart = autoInc[1];

  // Greedy up to the last quote, so a doubled quote inside the comment does
  // not end the match early. The comment is last in the clause.
  const comment = /\bCOMMENT='(.*)'/is.exec(clause);
  if (comment) opts.comment = unquote(comment[1]);

  return opts;
}
