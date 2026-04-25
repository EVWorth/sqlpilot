use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub query_id: String,
    pub statement_index: usize,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<SqlValue>>,
    pub rows_affected: u64,
    pub execution_time_ms: u64,
    pub warnings: Vec<String>,
    pub rows_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_rows_available: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SqlValue {
    Null,
    Bool(bool),
    Int(i64),
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
