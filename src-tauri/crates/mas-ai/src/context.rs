use mas_core::schema::SchemaInspector;

use crate::error::AiError;

const MAX_CONTEXT_CHARS: usize = 4000;

/// Builds a compact schema description for LLM context from the connected database.
pub async fn build_schema_context(
    inspector: &SchemaInspector,
    connection_id: &str,
    database: &str,
) -> Result<String, AiError> {
    tracing::debug!(connection_id = %connection_id, database = %database, "Building schema context");

    let tables = inspector
        .get_tables(connection_id, database)
        .await
        .map_err(|e| AiError::ContextError(format!("Failed to fetch tables: {}", e)))?;

    let mut ddl_snippets: Vec<(String, String)> = Vec::new();
    let mut total_len = 0usize;

    for table in &tables {
        if table.table_type == "VIEW" {
            continue;
        }

        let columns = inspector
            .get_columns(connection_id, database, &table.name)
            .await
            .map_err(|e| {
                AiError::ContextError(format!(
                    "Failed to fetch columns for {}: {}",
                    table.name, e
                ))
            })?;

        let mut ddl = format!("CREATE TABLE `{}` (\n", table.name);
        for (i, col) in columns.iter().enumerate() {
            let nullable = if col.nullable { "NULL" } else { "NOT NULL" };
            let pk = if col.is_primary_key {
                " PRIMARY KEY"
            } else {
                ""
            };
            let extra = if col.extra.is_empty() {
                String::new()
            } else {
                format!(" {}", col.extra)
            };

            ddl.push_str(&format!(
                "  `{}` {}{}{}{}",
                col.name, col.column_type, pk, extra, 
                if col.nullable && !col.is_primary_key { format!(" {}", nullable) } else { String::new() }
            ));
            if i < columns.len() - 1 {
                ddl.push(',');
            }
            ddl.push('\n');
        }
        ddl.push_str(");");

        let snippet_len = ddl.len();

        // Check budget before adding
        if total_len + snippet_len > MAX_CONTEXT_CHARS && !ddl_snippets.is_empty() {
            tracing::debug!(
                tables_included = ddl_snippets.len(),
                tables_total = tables.len(),
                "Schema context budget exceeded, truncating"
            );
            break;
        }

        total_len += snippet_len + 1; // +1 for newline separator
        ddl_snippets.push((table.name.clone(), ddl));
    }

    let mut context = format!("-- Database: `{}`\n", database);
    context.push_str(&format!("-- Tables: {}\n\n", ddl_snippets.len()));
    for (_, ddl) in &ddl_snippets {
        context.push_str(ddl);
        context.push('\n');
    }

    tracing::debug!(
        context_len = context.len(),
        tables_included = ddl_snippets.len(),
        "Schema context built"
    );

    Ok(context)
}
