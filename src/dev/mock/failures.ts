// Error injection: `?mock=connected&fail=get_foreign_keys,save_connection_profile`.
//
// Every command named in `fail=` rejects instead of answering, so each
// screen's error state can be looked at without wrapping `invoke` by hand. A
// name ending in `*` matches by prefix: `fail=get_*` fails every schema read.
//
// The rejection has the shape the real command rejects with, because that is
// what the UI has to cope with. The three commands typed `QueryError` in the
// bindings reject with that object; everything else rejects with the string
// a `CoreError` renders as. A plugin command (`plugin:updater|check`) rejects
// with a plain string, as Tauri's plugins do.

import type { QueryError } from "../../lib/bindings";
import { state } from "./state";

/** The commands whose error type in `bindings.ts` is `QueryError`. */
export const QUERY_ERROR_COMMANDS = new Set(["execute_query", "apply_grid_edits", "sqlite_execute"]);

const LOST = "Lost connection to MySQL server during query";
const DRIVER_LOST = `error returned from database: 2013 (HY000): ${LOST}`;

function matches(pattern: string, cmd: string): boolean {
  return pattern.endsWith("*") ? cmd.startsWith(pattern.slice(0, -1)) : pattern === cmd;
}

/** The text a failing command of this family rejects with. */
function messageFor(cmd: string): string {
  if (cmd.startsWith("plugin:")) return `${cmd.replace(/^plugin:/, "").replace("|", ".")} failed: network error`;
  if (/connection_profile|^history_|^keyring/.test(cmd)) return "Storage error: database is locked";
  if (cmd === "connect" || cmd === "test_connection" || cmd === "ping_connection") {
    return "Connection error: error communicating with database: Connection reset by peer (os error 104)";
  }
  if (/^(pick_|read_file|write_file)/.test(cmd)) {
    return "Storage error: Permission denied (os error 13)";
  }
  if (/^get_|_ddl$/.test(cmd)) return `Schema error: ${DRIVER_LOST}`;
  if (/^sqlite_/.test(cmd)) return "Query error: database is locked";
  if (/agent/.test(cmd)) return "The agent endpoint did not answer: connection refused";
  return `Query error: ${DRIVER_LOST}`;
}

/**
 * What `cmd` rejects with, when the URL says it should fail; undefined when
 * it should answer as usual.
 */
export function injectedFailure(cmd: string): string | QueryError | undefined {
  if (!state.options.fail.some((p) => matches(p, cmd))) return undefined;
  if (QUERY_ERROR_COMMANDS.has(cmd)) {
    return cmd === "sqlite_execute"
      ? { message: "database is locked", code: 5, sqlState: null, statementIndex: 0 }
      : { message: LOST, code: 2013, sqlState: "HY000", statementIndex: 0 };
  }
  return messageFor(cmd);
}
