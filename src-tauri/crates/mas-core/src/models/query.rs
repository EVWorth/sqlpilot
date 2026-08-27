use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct QueryResult {
    pub query_id: String,
    // JSON already serialises this as a number and JS truncates past 2^53;
    // declaring it as f64 documents the existing behaviour rather than
    // changing it. Row counts, byte sizes, timings and ids never approach it.
    #[specta(type = f64)]
    pub statement_index: usize,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<SqlValue>>,
    #[specta(type = f64)]
    pub rows_affected: u64,
    #[specta(type = f64)]
    pub execution_time_ms: u64,
    pub warnings: Vec<String>,
    pub rows_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub total_rows_available: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum SqlValue {
    Null,
    Bool(bool),
    // BIGINT cell values: serde_json already emits these as JSON numbers and
    // JS truncates past 2^53. Declaring f64 documents the existing lossy
    // round-trip rather than introducing it. See issue for a lossless fix.
    #[specta(type = f64)]
    Int(i64),
    #[specta(type = f64)]
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
