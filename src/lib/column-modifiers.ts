/**
 * Reading the parts of a column definition that COLUMN_TYPE hides in plain
 * sight, and EXTRA keeps elsewhere.
 *
 * The designer loaded a column by taking the leading word of COLUMN_TYPE as
 * the type and whatever was in brackets as the length, and discarded the
 * rest. `int(10) unsigned zerofill` came back as INT and "10". Editing that
 * column then emitted
 *
 *     MODIFY COLUMN `big` INT(10) NOT NULL
 *
 * which drops UNSIGNED. Confirmed against MySQL 8, both ways it can go:
 *
 *   - strict mode, the default: the ALTER fails outright with ERROR 1264 if
 *     any row is above 2^31-1, and otherwise succeeds — leaving a signed
 *     column that rejects those values from then on
 *   - non-strict mode: existing data is clamped. 4000000000 became
 *     2147483647, silently (#377)
 */

export interface ColumnModifiers {
  /** The type name alone, uppercased: `INT`, `VARCHAR`, `TIMESTAMP`. */
  baseType: string;
  /** Whatever was in brackets, as written: `10`, `10,2`, `'a','b'`. */
  length: string;
  unsigned: boolean;
  zerofill: boolean;
}

/**
 * Split `int(10) unsigned zerofill` into its parts.
 *
 * The bracketed section is matched to the *last* closing bracket, so an ENUM
 * whose members contain one — `enum('a)','b')` — keeps its whole list.
 */
export function parseColumnType(columnType: string): ColumnModifiers {
  const raw = columnType.trim();
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");

  let head: string;
  let length = "";
  let tail: string;

  if (open !== -1 && close > open) {
    head = raw.slice(0, open);
    length = raw.slice(open + 1, close);
    tail = raw.slice(close + 1);
  } else {
    const firstSpace = raw.indexOf(" ");
    head = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
    tail = firstSpace === -1 ? "" : raw.slice(firstSpace);
  }

  const attrs = tail.toUpperCase();
  return {
    baseType: head.trim().toUpperCase(),
    length,
    unsigned: /\bUNSIGNED\b/.test(attrs),
    // ZEROFILL implies UNSIGNED in MySQL, and is reported alongside it.
    zerofill: /\bZEROFILL\b/.test(attrs),
  };
}

/**
 * The `ON UPDATE ...` clause, if EXTRA carries one.
 *
 * EXTRA for such a column reads `DEFAULT_GENERATED on update CURRENT_TIMESTAMP`
 * — the first part describes the DEFAULT and must not be re-emitted, so only
 * the ON UPDATE half is taken.
 */
export function parseOnUpdate(extra: string): string {
  const match = /\bon update\s+(.+)$/i.exec(extra.trim());
  return match ? match[1].trim() : "";
}
