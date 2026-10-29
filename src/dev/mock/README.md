# Mock backend

A fake backend for running the UI in a browser: `just dev-web`, then open
`http://localhost:1420/?mock`. Every backend command is answered by a handler
in `handlers/`, keyed by its Rust name; `__tests__/coverage.test.ts` fails when
one is missing. See the `ui-preview` skill for driving it with Playwright.

## Scenarios

The starting point, as `?mock=<scenario>`. One at a time.

| URL               | Starts with                                                  |
| ----------------- | ------------------------------------------------------------ |
| `?mock`           | the saved profiles, nothing connected                        |
| `?mock=empty`     | a first run: no saved profiles                               |
| `?mock=connected` | "Local dev" connected, for the editor, grid and schema tree  |
| `?mock=lost`      | `connected`, then the server goes: see below                 |
| `?mock=servers`   | the default profiles plus four more, one per connect outcome |

`?mock=lost` connects "Local dev" and, four seconds later, stops answering. The
health check fails every three seconds and reports each failure, so the tab
turns red and the status bar counts "Lost — retrying (n)". Queries fail with
2013 (`QueryError` from `execute_query`, text from the schema reads), a ping
counts as one more failed check, and Disconnect still works.

`?mock=servers` adds:

| Profile                 | Connecting to it                                                           |
| ----------------------- | -------------------------------------------------------------------------- |
| Production (read-write) | connects; production that takes writes, shared with agents in full         |
| MariaDB 11              | connects to MariaDB 11.4                                                   |
| Wrong password          | rejected by the server with 1045, after the backend's credentials hint     |
| Unreachable (times out) | no answer: fails after two 2s connect timeouts, with the backend's wording |

Test Connection reports the same outcomes inline. A new profile in the dialog
pointing at `db.qa.example.internal` or `10.20.30.40` behaves the same way.

## Switches

Separate URL parameters, which combine with any scenario and with each other:
`?mock=connected&fail=get_foreign_keys`.

| Parameter               | Effect                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `fail=<cmd>,<cmd>`      | those commands reject with the error shape the real one has; `get_*` matches by prefix |
| `update=available`      | the updater offers 1.5.0, which downloads in about five seconds                        |
| `update=downloading`    | the same release, downloading over two minutes, to look at the progress                |
| `update=download-error` | the download breaks halfway                                                            |
| `update=error`          | the update check fails                                                                 |
| `keyring=missing`       | no OS credential store: "Passwords not saved"                                          |
| `startup=problems`      | the connection and history stores could not be opened at startup                       |

The update chip appears after the automatic check; click it to download.

`fail=` takes the Rust command names from `src/lib/bindings.ts`
(`get_foreign_keys`, `save_connection_profile`) or a plugin command
(`plugin:updater|check`). `execute_query`, `apply_grid_edits` and
`sqlite_execute` reject with a `QueryError`; every other command rejects with
the string its `CoreError` renders as. The console names each injected failure.

## Built-in behaviour

Some states need no switch, only the right click:

- **Connect:** "Staging" takes a second and a half; "MariaDB sandbox" is
  refused; "Production (read-only)" refuses writes.
- **Ports:** `save_connection_profile` and `test_connection` reject a port
  that is not a u16 (70000, -1, 3306.5) with the message Tauri gives when the
  argument fails to deserialize. Port 0 is a u16 and is accepted, as in the
  app; connecting to it is refused.
- **Query errors:** a statement containing `syntax_error` or starting with a
  misspelt verb fails with 1064; an unknown table with 1146; `SELECT SLEEP(n)`
  waits up to 5s and Cancel interrupts it.
- **Backup and restore** run for about three seconds of real time.
