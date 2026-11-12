# Backend-owned results

Status: in progress. The store exists in `mas-core` (`src/results/`); nothing uses it yet. Tracking issue: #967.

## Why

A query result is built whole in the backend, sent whole to the webview in one
IPC message, and kept whole in the webview until its tab closes. Measured on
v1.5.1 (`cargo test -p mas-core --release --test memory_baseline`, and the same
JSON parsed in Chromium):

|                            | 100,000 narrow rows | 100 rows of 1 MB BLOB |
| -------------------------- | ------------------- | --------------------- |
| Cell data                  | 12.8 MB             | 100 MB                |
| Backend, rows held         | 83.7 MB             | 103 MB (peak 204 MB)  |
| IPC JSON                   | 14.6 MB             | 357 MB                |
| Backend peak (rows + JSON) | 106 MB              | 461 MB                |
| Webview, parsed rows       | 23.7 MB             | 400 MB                |

Export makes it worse: the webview sends the whole result back to the backend
and receives the file's text in return.

The row limit and `MemoryGuard` bound how big a result may get. Neither removes
a copy. This design removes them: the backend owns the result, and the webview
holds only the rows on screen.

## Shape

```
server ──rows──▶ executor ──batches──▶ result store (SQLite file)
                                            │
                     window of rows ◀───────┤  result_window(id, range, sort, filter)
                     one full cell  ◀───────┤  result_cell(id, row, column)
                     export file    ◀───────┘  result_export(id, format, path)
```

The grid asks for the rows it is showing plus a margin, and drops rows that
scroll away. There is no "load more": the whole result is in the store and the
scrollbar covers all of it.

## The store

One SQLite database file per app run, in the app's cache directory, with one
table per result. SQLite because:

- memory stays bounded by its page cache and the rest is on disk, with no
  spill logic of our own;
- sort and filter are `ORDER BY` and `WHERE`, so the grid does not need the
  rows to sort them;
- BLOBs are stored as bytes, once;
- `rusqlite` is already bundled for history and for the user's SQLite files.

A result table has one column per result column, in order, named by position
(`c0`, `c1`, …) so duplicate and empty column names need no escaping. `rowid`
is the row's position in the result as the server returned it, starting at 1.
That is the row's identity: selection, pending edits and "row 4,812" all use
it, and it does not change when the view is sorted or filtered.

Values are stored in SQLite's own types. The result's column metadata keeps
the server's type, which decides how a column is read back and compared:

| Server value                 | Stored as | Notes                                       |
| ---------------------------- | --------- | ------------------------------------------- |
| NULL                         | NULL      |                                             |
| integers up to 32 bits, BOOL | INTEGER   |                                             |
| unsigned above `i64::MAX`    | TEXT      | sorted and compared as a number             |
| FLOAT, DOUBLE                | REAL      |                                             |
| DECIMAL                      | TEXT      | kept exact; sorted and compared as a number |
| text, dates, JSON            | TEXT      |                                             |
| binary                       | BLOB      |                                             |

A cell comes back as exactly the value that went in. `BIGINT` already travels
as text, so JSON cannot round it, and is stored as text like `DECIMAL`. The
store records, per column, which kind its integer cells and its text cells
are; the rare cell that differs is noted in a side table.

## Writing

The executor hands rows to the store in batches as they arrive, inside one
transaction per result. It never holds more than a batch. What the command
returns is a handle:

```rust
pub struct ResultHandle {
    pub result_id: String,
    pub statement_index: usize,
    pub sql: String,
    pub columns: Vec<ColumnMeta>,
    pub row_count: u64,
    pub rows_affected: u64,
    pub execution_time_ms: u64,
    pub warnings: Vec<String>,
    pub truncation_reason: Option<TruncationReason>,
    pub transaction: Option<TransactionState>,
}
```

Results of the user's SQLite files (`mas-sqlite`) go through the same store.

## Reading

```rust
result_window(result_id, offset, count, sort: Vec<SortKey>, filters: Vec<ColumnFilter>)
    -> ResultWindow { rows: Vec<Vec<Cell>>, row_ids: Vec<u64>, matching_rows: u64 }
result_cell(result_id, row_id, column) -> SqlValue      // the full value
result_export(result_id, format, path, sort, filters, row_ids?) -> ExportSummary
result_release(result_ids)
```

- **Large cells.** A window carries at most a fixed number of bytes of each
  cell (64 KB to start). A longer value arrives as its first bytes plus its
  real length; the cell viewer, a copy or an edit fetches the whole value with
  `result_cell`.
- **Binary.** Bytes cross IPC as base64 in a tagged object, never as an array
  of numbers.
- **Sort and filter** are translated to SQL in one place in the backend. The
  operators are the ones `src/lib/grid-filter.ts` has today, and the same test
  cases run against both until the frontend version is deleted.
- **Export and copy** read from the store. An export is written straight to
  the chosen file; nothing passes through the webview.

## Lifetime

A result belongs to the editor tab that ran it. It is released when the tab
runs again, closes, or its connection closes. A tab that is not shown keeps its
result ids, not its rows. The store file is deleted on exit, and any file left
by a crash is deleted at the next start.

The store has a size budget (a setting). A run that would exceed it stops
reading and reports the result as truncated, which replaces `MemoryGuard`'s
free-memory check.

## What stays as it is

- `execute_query` keeps returning whole results for callers that are not the
  results grid and whose results are small: the admin tabs, the schema tree,
  the routine viewer, EXPLAIN.
- The row limit setting. It also protects the server from an accidental
  `SELECT *` on a huge table, so it stays a preference. Whether its default
  should rise once results are cheap to hold is a separate decision.
- Grid edits still run as statements on the tab's session
  (`apply_grid_edits`). Pending edits are keyed by row id.

## Security

Results are written to disk, which they are not today. The file is created
with owner-only permissions in the app's private cache directory, is never
synced or backed up by the app, and is removed on exit and at start. Read
`docs/SECURITY.md` before changing where it lives. An in-memory store with the
same interface is possible if on-disk results are unacceptable for a user; it
would bring back a memory ceiling.

## Open points

- **Very wide results.** SQLite allows 2,000 columns in a table by default;
  MySQL allows 4,096. Decide before the executor writes to the store: raise
  SQLite's limit at build time, or split wide results across tables.
- **Sorting a large result** spills to SQLite's own temporary files, which go
  to the system temporary directory rather than the cache directory. They are
  unlinked as soon as they are opened on Unix.
- **Sorted windows deep into a large result** sort every row each time (about
  180 ms at row 90,000 of 100,000). Keeping the sorted row order per
  (result, sort, filter) turns them into seeks.

## Stages

Each stage is one or more PRs into `dev`, and each re-runs the baseline.

1. **Store and commands.** The store in `mas-core`, the executor writing into
   it, `result_window`, `result_cell`, `result_release`, bindings, API and
   mock. Nothing in the UI uses them yet.
2. **Grid on windows.** The results grid reads windows; sort and filter run in
   the backend; hidden tabs keep ids.
3. **Everything that reads rows.** Copy, export, the cell and BLOB viewers,
   grid edits, row counts, the agent's result context.
4. **Remove the old path** for editor results, and `MemoryGuard` with it.

## Risks

- **Write speed.** Inserting must not make ordinary queries feel slower.
  Target: 100,000 narrow rows stored in under 300 ms. Measure in stage 1.
- **Sort and filter drift** from what the grid does now (NULL order, numeric
  text, case). Covered by running the existing cases against both.
- **Scroll latency.** Each window is an IPC round trip. Fetch a margin around
  the viewport and keep the last few windows.
- **Disk use** for very large results; bounded by the budget above.
