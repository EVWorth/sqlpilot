use mas_core::models::{QueryResult, SqlValue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ExportFormat {
    Csv,
    Json,
    SqlInsert,
    Markdown,
}

#[tracing::instrument(skip(result), fields(rows = result.rows.len(), cols = result.columns.len()))]
pub fn export_csv(result: &QueryResult) -> String {
    let mut out = String::new();
    // Header
    let headers: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
    out.push_str(&headers.join(","));
    out.push('\n');
    // Rows
    for row in &result.rows {
        let vals: Vec<String> = row
            .iter()
            .map(|v| match v {
                SqlValue::Null => "NULL".to_string(),
                SqlValue::String(s) => format!("\"{}\"", s.replace('"', "\"\"")),
                other => other.to_string(),
            })
            .collect();
        out.push_str(&vals.join(","));
        out.push('\n');
    }
    tracing::debug!(output_bytes = out.len(), "CSV export complete");
    out
}

#[tracing::instrument(skip(result), fields(rows = result.rows.len(), cols = result.columns.len()))]
pub fn export_json(result: &QueryResult) -> String {
    let rows: Vec<serde_json::Value> = result
        .rows
        .iter()
        .map(|row| {
            let obj: serde_json::Map<String, serde_json::Value> = result
                .columns
                .iter()
                .zip(row.iter())
                .map(|(col, val)| {
                    let json_val = match val {
                        SqlValue::Null => serde_json::Value::Null,
                        SqlValue::Bool(b) => serde_json::Value::Bool(*b),
                        SqlValue::Int(i) => serde_json::json!(*i),
                        SqlValue::UInt(u) => serde_json::json!(*u),
                        SqlValue::Float(f) => serde_json::json!(*f),
                        SqlValue::String(s) => serde_json::Value::String(s.clone()),
                        SqlValue::Bytes(b) => {
                            serde_json::Value::String(format!("[{} bytes]", b.len()))
                        }
                    };
                    (col.name.clone(), json_val)
                })
                .collect();
            serde_json::Value::Object(obj)
        })
        .collect();
    let out = serde_json::to_string_pretty(&rows).unwrap_or_default();
    tracing::debug!(output_bytes = out.len(), "JSON export complete");
    out
}

#[tracing::instrument(skip(result), fields(rows = result.rows.len(), cols = result.columns.len()))]
pub fn export_sql_insert(result: &QueryResult, table_name: &str) -> String {
    let mut out = String::new();
    let col_names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
    for row in &result.rows {
        let vals: Vec<String> = row
            .iter()
            .map(|v| match v {
                SqlValue::Null => "NULL".to_string(),
                SqlValue::Bool(b) => {
                    if *b {
                        "TRUE".to_string()
                    } else {
                        "FALSE".to_string()
                    }
                }
                SqlValue::Int(i) => i.to_string(),
                SqlValue::UInt(u) => u.to_string(),
                SqlValue::Float(f) => f.to_string(),
                SqlValue::String(s) => format!("'{}'", s.replace('\'', "\\'")),
                SqlValue::Bytes(_) => "X'...'".to_string(),
            })
            .collect();
        out.push_str(&format!(
            "INSERT INTO `{}` ({}) VALUES ({});\n",
            table_name,
            col_names
                .iter()
                .map(|c| format!("`{}`", c))
                .collect::<Vec<_>>()
                .join(", "),
            vals.join(", ")
        ));
    }
    tracing::debug!(output_bytes = out.len(), "SQL INSERT export complete");
    out
}

#[tracing::instrument(skip(result), fields(rows = result.rows.len(), cols = result.columns.len()))]
pub fn export_markdown(result: &QueryResult) -> String {
    let mut out = String::new();
    let headers: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
    out.push_str("| ");
    out.push_str(&headers.join(" | "));
    out.push_str(" |\n");
    out.push_str("| ");
    out.push_str(
        &headers
            .iter()
            .map(|_| "---")
            .collect::<Vec<_>>()
            .join(" | "),
    );
    out.push_str(" |\n");
    for row in &result.rows {
        let vals: Vec<String> = row.iter().map(|v| v.to_string()).collect();
        out.push_str("| ");
        out.push_str(&vals.join(" | "));
        out.push_str(" |\n");
    }
    tracing::debug!(output_bytes = out.len(), "Markdown export complete");
    out
}
