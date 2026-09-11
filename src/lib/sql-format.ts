import { format } from "sql-formatter";
import type { FormatterSettings } from "../stores/settingsStore";
import { postProcessSQL } from "./sql-post-process";

/**
 * Formatting SQL the way the user's settings say to.
 *
 * The same twelve options were spelled out in three places — the toolbar
 * button, the editor's own command, and now the settings dialog's preview.
 * A preview that reproduced the mapping by hand would be a fourth copy, and
 * the one thing a preview must not do is disagree with what the button does
 * (#355).
 */

/** A representative statement, for previewing settings with nothing to format. */
export const PREVIEW_SQL = `select o.id, o.total_amount, c.name as customer, count(i.id) as items
from orders o
join customers c on c.id = o.customer_id
left join order_items i on i.order_id = o.id
where o.status = 'shipped' and o.total_amount > 100
group by o.id, o.total_amount, c.name
order by o.total_amount desc;`;

/**
 * Format, or return the input unchanged.
 *
 * A half-written statement is the normal case while typing, and
 * `sql-formatter` throws on one. Leaving the text alone is the only sensible
 * answer: the alternative is destroying what the user was working on.
 */
export function formatSql(sql: string, settings: FormatterSettings): string {
  try {
    return postProcessSQL(format(sql, {
      language: "mysql",
      keywordCase: settings.keywordCase,
      identifierCase: settings.identifierCase,
      dataTypeCase: settings.dataTypeCase,
      functionCase: settings.functionCase,
      indentStyle: settings.indentStyle,
      tabWidth: settings.tabWidth,
      useTabs: settings.useTabs,
      logicalOperatorNewline: settings.logicalOperatorNewline,
      newlineBeforeSemicolon: settings.newlineBeforeSemicolon,
      expressionWidth: settings.expressionWidth,
      linesBetweenQueries: settings.linesBetweenQueries,
      denseOperators: settings.denseOperators,
    }));
  } catch {
    return sql;
  }
}
