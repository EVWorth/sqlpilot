//! What the tools return, as distinct from what the app stores.
//!
//! These deliberately do not reuse the app's own schema models. Two reasons.
//!
//! The narrow one is mechanical: a tool's output schema has to be describable
//! in JSON Schema, and the app's models are specta types aimed at TypeScript.
//!
//! The real one is that everything here costs context. A model reading forty
//! tables pays for every field, so the answer should carry what a person
//! writing a query needs — a column's type, whether it is nullable, what it
//! comments — and not the app's internal bookkeeping. Keeping the two shapes
//! separate also means the agent-facing contract does not change because a
//! panel in the UI needed another field.

use serde::Serialize;

use mas_core::models::query::{ColumnMeta, SqlValue};
use mas_core::schema::inspector::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ReferencingKey, SchemaMatch, TableInfo,
};

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Database {
    pub name: String,
    pub charset: String,
    pub collation: String,
    /// True for the server's own schemas — `mysql`, `information_schema` and
    /// friends. Reported rather than hidden: they are legitimately useful, and
    /// an agent should know which ones they are.
    pub system: bool,
}

impl From<DatabaseInfo> for Database {
    fn from(d: DatabaseInfo) -> Self {
        Self {
            name: d.name,
            charset: d.default_charset,
            collation: d.default_collation,
            system: d.is_system,
        }
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Table {
    pub name: String,
    /// "BASE TABLE" or "VIEW".
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// InnoDB's estimate, which can be out by a wide margin. Good enough to
    /// tell a lookup table from a fact table, not good enough to report as a
    /// count — `run_select` with `COUNT(*)` is the count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approximate_rows: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_size_bytes: Option<i64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub comment: String,
}

impl From<TableInfo> for Table {
    fn from(t: TableInfo) -> Self {
        Self {
            name: t.name,
            kind: t.table_type,
            engine: t.engine,
            approximate_rows: t.row_count,
            data_size_bytes: t.data_size,
            comment: t.comment,
        }
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Column {
    pub name: String,
    /// The full declared type, `varchar(255)` rather than `varchar`, because
    /// the length is half of what makes a column wrong to write to.
    #[serde(rename = "type")]
    pub column_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// `auto_increment`, `on update CURRENT_TIMESTAMP`, and the rest.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub extra: String,
    /// Often the only documentation a column has.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub comment: String,
}

impl From<ColumnInfo> for Column {
    fn from(c: ColumnInfo) -> Self {
        Self {
            name: c.name,
            column_type: c.column_type,
            nullable: c.nullable,
            primary_key: c.is_primary_key,
            default: c.default_value,
            extra: c.extra,
            comment: c.comment,
        }
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Index {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    /// BTREE, FULLTEXT, SPATIAL, HASH.
    pub kind: String,
}

impl From<IndexInfo> for Index {
    fn from(i: IndexInfo) -> Self {
        Self {
            name: i.name,
            columns: i.columns,
            unique: i.is_unique,
            kind: i.index_type,
        }
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub references_table: String,
    pub references_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

impl From<ForeignKeyInfo> for ForeignKey {
    fn from(k: ForeignKeyInfo) -> Self {
        Self {
            name: k.name,
            columns: k.columns,
            references_table: k.referenced_table,
            references_columns: k.referenced_columns,
            on_update: k.on_update,
            on_delete: k.on_delete,
        }
    }
}

/// A foreign key pointing at the table that was asked about.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ReferencedBy {
    /// The table that declares the constraint.
    pub table: String,
    pub name: String,
    /// Columns on `table`.
    pub columns: Vec<String>,
    /// Columns on the table that was asked about.
    pub references_columns: Vec<String>,
    pub on_update: String,
    /// What happens to these rows when the referenced row goes. `CASCADE`
    /// here is the difference between deleting one row and deleting a
    /// thousand.
    pub on_delete: String,
}

impl From<ReferencingKey> for ReferencedBy {
    fn from(k: ReferencingKey) -> Self {
        Self {
            table: k.table,
            name: k.name,
            columns: k.columns,
            references_columns: k.referenced_columns,
            on_update: k.on_update,
            on_delete: k.on_delete,
        }
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Match {
    pub table: String,
    pub column: String,
    #[serde(rename = "type")]
    pub column_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub comment: String,
}

impl From<SchemaMatch> for Match {
    fn from(m: SchemaMatch) -> Self {
        Self {
            table: m.table,
            column: m.column,
            column_type: m.column_type,
            comment: m.comment,
        }
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ResultColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    pub nullable: bool,
}

impl From<ColumnMeta> for ResultColumn {
    fn from(c: ColumnMeta) -> Self {
        Self {
            name: c.name,
            data_type: c.data_type,
            nullable: c.nullable,
        }
    }
}

/// One cell, as JSON.
///
/// Binary is the only interesting case: a BLOB rendered as an array of byte
/// numbers is both enormous and useless to read, so it arrives as a note about
/// its size. Anything that needs the bytes themselves needs a tool that deals
/// in bytes, not a chat transcript.
pub fn cell_to_json(value: SqlValue) -> serde_json::Value {
    match value {
        SqlValue::Null => serde_json::Value::Null,
        SqlValue::Bool(b) => serde_json::Value::Bool(b),
        SqlValue::Int(i) => serde_json::Value::from(i),
        SqlValue::UInt(u) => serde_json::Value::from(u),
        SqlValue::Float(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            // NaN and infinity have no JSON spelling. The string keeps the
            // fact that there was a value there, which null would lose.
            .unwrap_or_else(|| serde_json::Value::String(f.to_string())),
        SqlValue::String(s) => serde_json::Value::String(s),
        SqlValue::Bytes(b) => serde_json::Value::String(format!("<{} bytes>", b.len())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blob_arrives_as_its_size_rather_than_as_numbers() {
        // A 2 MB BLOB rendered as a JSON array of bytes is 8 MB of context
        // that says nothing.
        assert_eq!(
            cell_to_json(SqlValue::Bytes(vec![0; 2048])),
            serde_json::json!("<2048 bytes>")
        );
    }

    #[test]
    fn a_big_integer_keeps_its_value() {
        // Through JSON, not through f64: the frontend's 2^53 truncation is a
        // display problem, and repeating it here would corrupt the number an
        // agent then writes into a WHERE clause.
        let big = 9_007_199_254_740_993_i64;
        assert_eq!(
            cell_to_json(SqlValue::Int(big)).to_string(),
            big.to_string()
        );
    }

    #[test]
    fn a_value_with_no_json_spelling_is_not_silently_null() {
        assert_eq!(
            cell_to_json(SqlValue::Float(f64::INFINITY)),
            serde_json::json!("inf")
        );
    }

    #[test]
    fn null_is_null_and_not_the_string_null() {
        // `WHERE x = 'NULL'` is the bug this prevents.
        assert!(cell_to_json(SqlValue::Null).is_null());
    }
}
