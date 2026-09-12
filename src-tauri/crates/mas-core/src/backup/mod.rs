//! Writing a database out as a SQL file.
//!
//! The dump used to be built in the renderer: every CREATE and every INSERT
//! concatenated into one JavaScript string, handed across IPC in a single
//! call, and written to disk at the end. A ten-million-row table meant
//! gigabytes held in the WebView before the file existed, and cancelling
//! could not give the memory back (#358). Rows were read with `LIMIT/OFFSET`
//! against the pool, which is quadratic and — with no ORDER BY and no shared
//! session — free to return a row twice or not at all.
//!
//! This writes straight to the file as it reads, on one connection, streaming
//! rows rather than collecting them. Memory is bounded by the buffer, not by
//! the size of the table, and the reader sees one consistent snapshot.

mod escape;
mod writer;

pub use escape::{escape_string, format_cell, shape_of, CellShape};
pub use writer::{run_backup, BackupOptions, BackupProgress, BackupSummary};
