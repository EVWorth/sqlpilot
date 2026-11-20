use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct QueryResult {
    pub query_id: String,
    // JSON already serialises this as a number and JS truncates past 2^53;
    // declaring it as f64 documents the existing behaviour rather than
    // changing it. Row counts, byte sizes, timings and ids never approach it.
    #[specta(type = specta_typescript::Number)]
    pub statement_index: usize,
    /// The statement this result came from.
    ///
    /// Carried rather than left to the caller to re-derive: a multi-statement
    /// run recorded one history entry for the whole batch, so a script whose
    /// third statement failed showed as one opaque failure (#329). Splitting
    /// the text again in the frontend would be a second splitter to keep in
    /// step with this one, and they would drift.
    pub sql: String,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<SqlValue>>,
    #[specta(type = specta_typescript::Number)]
    pub rows_affected: u64,
    #[specta(type = specta_typescript::Number)]
    pub execution_time_ms: u64,
    pub warnings: Vec<String>,
    /// Whether rows were withheld. Derived from `truncation_reason` at the one
    /// place a truncated result is built, so the two cannot disagree.
    pub rows_truncated: bool,
    /// Why rows were withheld, when they were. The banner needs this: telling
    /// someone to add a LIMIT is wrong advice when the cap was memory, and
    /// they will respond by raising a LIMIT that was never the constraint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncation_reason: Option<TruncationReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub total_rows_available: Option<u64>,
    /// Whether the editor tab's session is inside a transaction after this
    /// statement, read from the server rather than guessed from the SQL
    /// (#843).
    ///
    /// Only a run on a session reports it, and only on its last result: the
    /// server is asked once, after the whole run, so the statements before
    /// the last have nothing to report. `None` on the shared pool and on an
    /// agent's connections, which keep no session for a transaction to
    /// outlive the run in, and when the server could not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction: Option<crate::query::TransactionState>,
}

/// What stopped the result set from being complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TruncationReason {
    /// The caller's row limit was reached. Asking for fewer rows, or raising
    /// the limit, is a meaningful response.
    RowLimit,
    /// Available system memory fell below the guard's floor mid-fetch, so the
    /// fetch stopped early. A larger LIMIT cannot help; a narrower projection
    /// or a WHERE clause can.
    MemoryGuard,
    /// The result store reached its size budget, so the rest of the result
    /// was not kept. Only a run that writes to the store reports it.
    /// Releasing other results, or a narrower query, makes room; a larger
    /// LIMIT cannot.
    StoreFull,
}

/// What a run that writes to the result store returns for one statement, in
/// place of a [`QueryResult`]: everything but the rows, which stay in the
/// store and are read a window at a time (`docs/design/RESULT_STORE.md`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ResultHandle {
    /// What `result_window`, `result_cell` and `result_release` take.
    ///
    /// Always set and always unique, so it also names the result in the UI.
    /// The store holds rows under it only when `row_count` is above zero: a
    /// statement that reported a count, and a result set with no rows, write
    /// nothing, and the store does not know their id.
    pub result_id: String,
    #[specta(type = specta_typescript::Number)]
    pub statement_index: usize,
    /// The statement this result came from, as on [`QueryResult`].
    pub sql: String,
    /// Empty for a statement that reported a count, and for a result set
    /// with no rows at all (the columns are read from the first row).
    pub columns: Vec<ColumnMeta>,
    /// Rows in the store for this result.
    #[specta(type = specta_typescript::Number)]
    pub row_count: u64,
    /// What the server reported for a statement that changed rows. For a
    /// result set, the same as `row_count`, as on [`QueryResult`].
    #[specta(type = specta_typescript::Number)]
    pub rows_affected: u64,
    #[specta(type = specta_typescript::Number)]
    pub execution_time_ms: u64,
    pub warnings: Vec<String>,
    /// Why rows were withheld, when they were. A result is truncated exactly
    /// when this is set, so there is no separate flag to disagree with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncation_reason: Option<TruncationReason>,
    /// As on [`QueryResult`]: the session's transaction state after the run,
    /// on the last handle of a run on an editor tab's session only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction: Option<crate::query::TransactionState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum SqlValue {
    Null,
    Bool(bool),
    // BIGINT cell values: serde_json already emits these as JSON numbers and
    // JS truncates past 2^53. Declaring f64 documents the existing lossy
    // round-trip rather than introducing it. See issue for a lossless fix.
    #[specta(type = specta_typescript::Number)]
    Int(i64),
    #[specta(type = specta_typescript::Number)]
    UInt(u64),
    Float(f64),
    String(String),
    Bytes(Vec<u8>),
}

impl std::fmt::Display for SqlValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SqlValue::Null => write!(f, "NULL"),
            SqlValue::Bool(b) => write!(f, "{}", b),
            SqlValue::Int(i) => write!(f, "{}", i),
            SqlValue::UInt(u) => write!(f, "{}", u),
            SqlValue::Float(fl) => write!(f, "{}", fl),
            SqlValue::String(s) => write!(f, "{}", s),
            SqlValue::Bytes(b) => write!(f, "[{} bytes]", b.len()),
        }
    }
}
