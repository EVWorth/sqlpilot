use copilot_sdk::{Tool, ToolHandler, ToolResultObject};
use mas_admin::AdminService;
use mas_core::connection::ConnectionManager;
use mas_core::query::QueryExecutor;
use mas_core::schema::SchemaInspector;
use std::sync::Arc;
use std::time::Duration;

/// Run an async future synchronously with a timeout to prevent deadlocks.
/// Used because the copilot SDK ToolHandler trait requires synchronous callbacks.
fn block_on_async<F: std::future::Future>(fut: F) -> F::Output {
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            tokio::time::timeout(Duration::from_secs(60), fut)
                .await
                .expect("AI tool execution timed out after 60s")
        })
    })
}

/// Build all read-only database tool definitions.
pub fn build_read_tools() -> Vec<Tool> {
    vec![
        Tool::new("list_databases")
            .description("List all databases on the connected MySQL server")
            .schema(serde_json::json!({"type": "object", "properties": {}, "required": []}))
            .skip_permission(true),
        Tool::new("list_tables")
            .description("List all tables in a specific database with row counts and sizes")
            .schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "database": {"type": "string", "description": "Database name"}
                },
                "required": ["database"]
            }))
            .skip_permission(true),
        Tool::new("describe_table")
            .description("Get detailed column definitions, types, nullable, primary keys, and indexes for a table")
            .schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "database": {"type": "string", "description": "Database name"},
                    "table": {"type": "string", "description": "Table name"}
                },
                "required": ["database", "table"]
            }))
            .skip_permission(true),
        Tool::new("get_table_ddl")
            .description("Get the full CREATE TABLE DDL statement for a table")
            .schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "database": {"type": "string", "description": "Database name"},
                    "table": {"type": "string", "description": "Table name"}
                },
                "required": ["database", "table"]
            }))
            .skip_permission(true),
        Tool::new("run_select_query")
            .description("Execute a read-only SELECT query against the database. Results limited to 1000 rows.")
            .schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "sql": {"type": "string", "description": "The SELECT SQL query to execute"}
                },
                "required": ["sql"]
            }))
            .skip_permission(true),
        Tool::new("explain_query")
            .description("Run EXPLAIN on a SQL query to show the execution plan")
            .schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "sql": {"type": "string", "description": "The SQL query to explain"}
                },
                "required": ["sql"]
            }))
            .skip_permission(true),
        Tool::new("list_routines")
            .description("List stored procedures and functions in a database")
            .schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "database": {"type": "string", "description": "Database name"}
                },
                "required": ["database"]
            }))
            .skip_permission(true),
        Tool::new("show_process_list")
            .description("Show active MySQL connections and running queries")
            .schema(serde_json::json!({"type": "object", "properties": {}, "required": []}))
            .skip_permission(true),
    ]
}

/// Build write/mutating tool definitions.
pub fn build_write_tools() -> Vec<Tool> {
    vec![
        Tool::new("run_query")
            .description("Execute any SQL statement (INSERT, UPDATE, DELETE, CREATE, ALTER, DROP). Use for data modifications and schema changes.")
            .schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "sql": {"type": "string", "description": "The SQL statement to execute"}
                },
                "required": ["sql"]
            })),
    ]
}

/// Create tool handler pairs for database operations.
pub fn build_tool_handlers(
    connection_manager: Arc<ConnectionManager>,
    connection_id: String,
) -> Vec<(Tool, ToolHandler)> {
    let inspector = Arc::new(SchemaInspector::new(connection_manager.clone()));
    let executor = Arc::new(QueryExecutor::new(connection_manager.clone()));
    let admin = Arc::new(AdminService::new(connection_manager));

    let mut pairs: Vec<(Tool, ToolHandler)> = Vec::new();

    // Read tools
    for tool in build_read_tools() {
        let handler = make_read_handler(
            &tool.name,
            inspector.clone(),
            executor.clone(),
            admin.clone(),
            connection_id.clone(),
        );
        pairs.push((tool, handler));
    }

    // Write tools
    for tool in build_write_tools() {
        let handler = make_write_handler(&tool.name, executor.clone(), connection_id.clone());
        pairs.push((tool, handler));
    }

    pairs
}

/// Create read-only tool handler pairs (for ask mode).
pub fn build_read_tool_handlers(
    connection_manager: Arc<ConnectionManager>,
    connection_id: String,
) -> Vec<(Tool, ToolHandler)> {
    let inspector = Arc::new(SchemaInspector::new(connection_manager.clone()));
    let executor = Arc::new(QueryExecutor::new(connection_manager.clone()));
    let admin = Arc::new(AdminService::new(connection_manager));

    build_read_tools()
        .into_iter()
        .map(|tool| {
            let handler = make_read_handler(
                &tool.name,
                inspector.clone(),
                executor.clone(),
                admin.clone(),
                connection_id.clone(),
            );
            (tool, handler)
        })
        .collect()
}

fn make_read_handler(
    tool_name: &str,
    inspector: Arc<SchemaInspector>,
    executor: Arc<QueryExecutor>,
    admin: Arc<AdminService>,
    connection_id: String,
) -> ToolHandler {
    let name = tool_name.to_string();
    Arc::new(
        move |_tool_name: &str, args: &serde_json::Value| -> ToolResultObject {
            let result = match name.as_str() {
                "list_databases" => handle_list_databases(&inspector, &connection_id),
                "list_tables" => {
                    let db = arg_str(args, "database");
                    handle_list_tables(&inspector, &connection_id, &db)
                }
                "describe_table" => {
                    let db = arg_str(args, "database");
                    let table = arg_str(args, "table");
                    handle_describe_table(&inspector, &connection_id, &db, &table)
                }
                "get_table_ddl" => {
                    let db = arg_str(args, "database");
                    let table = arg_str(args, "table");
                    handle_get_table_ddl(&inspector, &connection_id, &db, &table)
                }
                "run_select_query" => {
                    let sql = arg_str(args, "sql");
                    handle_run_select_query(&executor, &connection_id, &sql)
                }
                "explain_query" => {
                    let sql = arg_str(args, "sql");
                    handle_explain_query(&executor, &connection_id, &sql)
                }
                "list_routines" => {
                    let db = arg_str(args, "database");
                    handle_list_routines(&inspector, &connection_id, &db)
                }
                "show_process_list" => handle_show_process_list(&admin, &connection_id),
                _ => Err(format!("Unknown tool: {}", name)),
            };
            match result {
                Ok(text) => ToolResultObject::text(text),
                Err(e) => ToolResultObject::error(e),
            }
        },
    )
}

fn make_write_handler(
    tool_name: &str,
    executor: Arc<QueryExecutor>,
    connection_id: String,
) -> ToolHandler {
    let name = tool_name.to_string();
    Arc::new(
        move |_tool_name: &str, args: &serde_json::Value| -> ToolResultObject {
            let result = match name.as_str() {
                "run_query" => {
                    let sql = arg_str(args, "sql");
                    handle_run_query(&executor, &connection_id, &sql)
                }
                _ => Err(format!("Unknown tool: {}", name)),
            };
            match result {
                Ok(text) => ToolResultObject::text(text),
                Err(e) => ToolResultObject::error(e),
            }
        },
    )
}

fn arg_str(args: &serde_json::Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

// --- Tool handler implementations ---

fn handle_list_databases(
    inspector: &SchemaInspector,
    connection_id: &str,
) -> Result<String, String> {
    let dbs = block_on_async(inspector.get_databases(connection_id)).map_err(|e| e.to_string())?;
    let names: Vec<&str> = dbs.iter().map(|d| d.name.as_str()).collect();
    serde_json::to_string_pretty(&names).map_err(|e| e.to_string())
}

fn handle_list_tables(
    inspector: &SchemaInspector,
    connection_id: &str,
    database: &str,
) -> Result<String, String> {
    let tables =
        block_on_async(inspector.get_tables(connection_id, database)).map_err(|e| e.to_string())?;
    let rows: Vec<serde_json::Value> = tables
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "type": t.table_type,
                "engine": t.engine,
                "row_count": t.row_count,
                "data_size": t.data_size,
                "comment": t.comment,
            })
        })
        .collect();
    serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())
}

fn handle_describe_table(
    inspector: &SchemaInspector,
    connection_id: &str,
    database: &str,
    table: &str,
) -> Result<String, String> {
    let columns = block_on_async(inspector.get_columns(connection_id, database, table))
        .map_err(|e| e.to_string())?;
    let indexes = block_on_async(inspector.get_indexes(connection_id, database, table))
        .map_err(|e| e.to_string())?;

    let mut output = format!("Table: {}.{}\n\nColumns:\n", database, table);
    for col in &columns {
        output.push_str(&format!(
            "  {} {} {}{}{}\n",
            col.name,
            col.column_type,
            if col.nullable { "NULL" } else { "NOT NULL" },
            if col.is_primary_key { " PK" } else { "" },
            col.default_value
                .as_ref()
                .map(|d| format!(" DEFAULT {}", d))
                .unwrap_or_default(),
        ));
    }
    output.push_str("\nIndexes:\n");
    for idx in &indexes {
        output.push_str(&format!(
            "  {} ({}) {}\n",
            idx.name,
            idx.columns.join(", "),
            if idx.is_unique { "UNIQUE" } else { "" },
        ));
    }
    Ok(output)
}

fn handle_get_table_ddl(
    inspector: &SchemaInspector,
    connection_id: &str,
    database: &str,
    table: &str,
) -> Result<String, String> {
    block_on_async(inspector.get_table_ddl(connection_id, database, table))
        .map_err(|e| e.to_string())
}

fn handle_run_select_query(
    executor: &QueryExecutor,
    connection_id: &str,
    sql: &str,
) -> Result<String, String> {
    let trimmed = sql.trim();
    let upper = trimmed.to_uppercase();
    if !upper.starts_with("SELECT")
        && !upper.starts_with("SHOW")
        && !upper.starts_with("DESCRIBE")
        && !upper.starts_with("EXPLAIN")
        && !upper.starts_with("DESC ")
    {
        return Err("Only SELECT, SHOW, DESCRIBE, and EXPLAIN statements are allowed with this tool. Use run_query for modifications.".to_string());
    }

    let limited_sql = if upper.starts_with("SELECT") && !upper.contains("LIMIT") {
        format!("{} LIMIT 1000", trimmed.trim_end_matches(';'))
    } else {
        trimmed.to_string()
    };

    let results = block_on_async(executor.execute(connection_id, &limited_sql, None, None))
        .map_err(|e| e.to_string())?;

    format_query_results(&results)
}

fn handle_explain_query(
    executor: &QueryExecutor,
    connection_id: &str,
    sql: &str,
) -> Result<String, String> {
    let explain_sql = format!("EXPLAIN {}", sql.trim().trim_end_matches(';'));
    let results = block_on_async(executor.execute(connection_id, &explain_sql, None, None))
        .map_err(|e| e.to_string())?;

    format_query_results(&results)
}

fn handle_list_routines(
    inspector: &SchemaInspector,
    connection_id: &str,
    database: &str,
) -> Result<String, String> {
    let routines = block_on_async(inspector.get_routines(connection_id, database))
        .map_err(|e| e.to_string())?;
    let rows: Vec<serde_json::Value> = routines
        .iter()
        .map(|r| {
            serde_json::json!({
                "name": r.name,
                "type": r.routine_type,
                "data_type": r.data_type,
            })
        })
        .collect();
    serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())
}

fn handle_show_process_list(admin: &AdminService, connection_id: &str) -> Result<String, String> {
    let processes =
        block_on_async(admin.get_process_list(connection_id)).map_err(|e| e.to_string())?;
    let rows: Vec<serde_json::Value> = processes
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "user": p.user,
                "host": p.host,
                "db": p.db,
                "command": p.command,
                "time": p.time,
                "state": p.state,
                "info": p.info,
            })
        })
        .collect();
    serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())
}

fn handle_run_query(
    executor: &QueryExecutor,
    connection_id: &str,
    sql: &str,
) -> Result<String, String> {
    let trimmed = sql.trim();
    let upper = trimmed.to_uppercase();

    // Reject destructive DROP statements
    if upper.starts_with("DROP") {
        return Err(
            "DROP statements are not allowed via AI tools. Use the UI to drop tables/databases."
                .to_string(),
        );
    }

    // Warn if DELETE/UPDATE without WHERE (but allow — user must approve via permission dialog)
    if (upper.starts_with("DELETE") || upper.starts_with("UPDATE")) && !upper.contains("WHERE") {
        return Err(
            "DELETE/UPDATE without WHERE clause is not allowed via AI tools. Add a WHERE clause to proceed.".to_string(),
        );
    }

    let results = block_on_async(executor.execute(connection_id, trimmed, None, None))
        .map_err(|e| e.to_string())?;
    format_query_results(&results)
}

fn format_query_results(results: &[mas_core::models::QueryResult]) -> Result<String, String> {
    let mut output = String::new();
    for (i, result) in results.iter().enumerate() {
        if results.len() > 1 {
            output.push_str(&format!("--- Statement {} ---\n", i + 1));
        }
        if result.columns.is_empty() {
            output.push_str(&format!(
                "Rows affected: {}\nExecution time: {}ms\n",
                result.rows_affected, result.execution_time_ms
            ));
        } else {
            let col_names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
            output.push_str(&col_names.join("\t"));
            output.push('\n');
            for row in result.rows.iter().take(1000) {
                let vals: Vec<String> = row.iter().map(|v| format!("{}", v)).collect();
                output.push_str(&vals.join("\t"));
                output.push('\n');
            }
            output.push_str(&format!(
                "\n{} row(s) | {}ms\n",
                result.rows.len(),
                result.execution_time_ms
            ));
        }
    }
    Ok(output)
}

/// Build all tool definitions (read + write) without handlers.
pub fn all_tool_definitions() -> Vec<Tool> {
    let mut tools = build_read_tools();
    tools.extend(build_write_tools());
    tools
}
