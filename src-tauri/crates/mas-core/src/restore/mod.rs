//! Running a SQL dump back into a database.
//!
//! The restore used to read the whole file into the renderer, split it there,
//! and send the statements back one at a time. That caps a restore at what
//! the WebView can hold (256 MB, enforced by `read_file_contents`), sends the
//! file across IPC in full before the first statement runs, and gives each
//! statement its own pooled connection — so `USE`, `SET SESSION` and anything
//! transactional applied to a session that the next statement might not get.
//!
//! This reads the file in chunks, splits as it goes, and runs the statements
//! on one connection.

mod runner;
mod splitter;

pub use runner::{run_restore, RestoreOptions, RestoreProgress, RestoreSummary};
pub use splitter::{SplitError, StatementSplitter};
