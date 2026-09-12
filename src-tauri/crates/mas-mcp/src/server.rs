//! The tools, as an agent sees them.
//!
//! Every tool here does the same three things in the same order: work out
//! which connection is meant, ask the policy what is permitted, and only then
//! touch the database. The ordering is the point — a tool that queries first
//! and checks afterwards has already done the thing it was going to refuse.
//!
//! Tool descriptions are written for a model rather than for a manual. They
//! say what the tool is *for* and what to reach for instead, because a model
//! that hits a wall with no alternative rephrases and tries again, and a model
//! that is told "use `search_schema`" uses `search_schema`.

use std::sync::Arc;

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{ServerCapabilities, ServerInfo};
use rmcp::{tool, tool_handler, tool_router, ServerHandler};
use serde::{Deserialize, Serialize};

use crate::analysis::{check_identifier, profile_column_sql, table_stats_sql, top_values_sql};
use crate::classify::single_statement;
use crate::grants::ConnectionFacts;
use crate::policy::{ConnectionPolicy, Decision, VerbClass};
use crate::shapes::{
    cell_to_json, Column, Database, ForeignKey, Index, Match, ReferencedBy, ResultColumn, Table,
};
use crate::workspace::{LiveConnection, ObjectKind, Workspace};
use mas_core::query::{AnalyzeRefusal, ExplainFormat, FormatFallback};

/// How many of a column's most common values `profile_column` reports.
///
/// Ten is enough to see a distribution and short enough to read. More would
/// be a sample of the data by another name.
const TOP_VALUES: u32 = 10;

/// A count from an aggregate, which the driver may hand back as any integer
/// shape depending on the server.
fn as_count(value: Option<mas_core::models::query::SqlValue>) -> i64 {
    use mas_core::models::query::SqlValue;
    match value {
        Some(SqlValue::Int(n)) => n,
        Some(SqlValue::UInt(n)) => n as i64,
        Some(SqlValue::Float(n)) => n as i64,
        Some(SqlValue::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

/// A CAST(... AS CHAR) column, which is null when the table is empty.
fn as_text(value: Option<mas_core::models::query::SqlValue>) -> Option<String> {
    use mas_core::models::query::SqlValue;
    match value {
        Some(SqlValue::Null) | None => None,
        Some(SqlValue::String(s)) => Some(s),
        Some(other) => Some(other.to_string()),
    }
}

/// The knobs that are not per-connection.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// How many rows a `samples` posture returns.
    pub sample_rows: u32,
    /// The most rows any single `run_select` returns, whatever was asked for.
    ///
    /// A cap on the tool, not on the database: a model that writes
    /// `LIMIT 100000` is not usually wrong about what it wants, it is wrong
    /// about what will fit in its context.
    pub max_rows: u32,
    /// How many schema matches `search_schema` returns.
    pub search_matches: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            sample_rows: 20,
            max_rows: 500,
            search_matches: 200,
        }
    }
}

pub struct SqlPilot {
    workspace: Arc<dyn Workspace>,
    limits: Limits,
}

// ---------------------------------------------------------------- arguments

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConnectionArg {
    /// Connection id, from `list_connections`.
    pub connection: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DatabaseArg {
    /// Connection id, from `list_connections`.
    pub connection: String,
    /// Database name, from `list_databases`.
    pub database: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TableArg {
    pub connection: String,
    pub database: String,
    pub table: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DdlArg {
    pub connection: String,
    pub database: String,
    /// The object's name, unqualified.
    pub object: String,
    pub kind: ObjectKind,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ObjectsArg {
    pub connection: String,
    pub database: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchArg {
    pub connection: String,
    pub database: String,
    /// Part of a table or column name. Matched anywhere in the name;
    /// underscores and percent signs are literal.
    pub fragment: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RelatedArg {
    pub connection: String,
    pub database: String,
    pub table: String,
    /// How many foreign-key hops to follow. Defaults to 1, which is the
    /// question people actually ask; 2 is already most of a small schema.
    #[serde(default)]
    pub depth: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SelectArg {
    pub connection: String,
    /// The database to run in. Without it the connection's default is used,
    /// which is rarely what was meant on a server with more than one.
    #[serde(default)]
    pub database: Option<String>,
    /// One statement. Two is refused rather than truncated.
    pub sql: String,
    /// Rows wanted. Capped by the tool and by the connection's data posture.
    #[serde(default)]
    pub limit: Option<u32>,
}

// ------------------------------------------------------------------ results

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct TableDescription {
    pub database: String,
    pub table: String,
    pub columns: Vec<Column>,
    pub primary_key: Vec<String>,
    pub indexes: Vec<Index>,
    /// What this table points at.
    pub foreign_keys: Vec<ForeignKey>,
    /// What points at this table. The direction a schema dump does not carry,
    /// and the one that answers "what breaks if I delete this".
    pub referenced_by: Vec<ReferencedBy>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Objects {
    pub views: Vec<String>,
    pub procedures: Vec<String>,
    pub functions: Vec<String>,
    pub triggers: Vec<String>,
}

/// One step of the foreign-key walk.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Relation {
    pub from_table: String,
    pub from_columns: Vec<String>,
    pub to_table: String,
    pub to_columns: Vec<String>,
    /// How many hops from the table that was asked about.
    pub hops: u32,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct SelectResult {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub execution_time_ms: u64,
    /// Set when rows were withheld — by the posture, by the tool's cap, or by
    /// the executor. Says which, because "add a LIMIT" is wrong advice when
    /// the cap was the posture.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExplainArg {
    pub connection: String,
    #[serde(default)]
    pub database: Option<String>,
    /// One statement. The plan for two statements is not a thing.
    pub sql: String,
    /// "classic" (the default tabular plan), "json" (the optimiser's own cost
    /// model) or "tree" (the iterator tree, MySQL 8.0.16+).
    #[serde(default)]
    pub format: Option<PlanFormat>,
    /// Whether to run the statement and report what actually happened, rather
    /// than what the planner intends. Refused on a read-only connection and
    /// for anything that would change data; a plain plan comes back instead,
    /// with a note saying so.
    #[serde(default)]
    pub analyze: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PlanFormat {
    Classic,
    Json,
    Tree,
}

impl From<PlanFormat> for ExplainFormat {
    fn from(format: PlanFormat) -> Self {
        match format {
            PlanFormat::Classic => ExplainFormat::Classic,
            PlanFormat::Json => ExplainFormat::Json,
            PlanFormat::Tree => ExplainFormat::Tree,
        }
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Plan {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// True when these are measured timings rather than an estimate.
    pub analyzed: bool,
    /// The format that was actually served, which is not always the one asked
    /// for — MariaDB has no tree format, and JSON is not available everywhere.
    pub format: String,
    /// Set when something was asked for and quietly not done. A plan that
    /// silently was not ANALYZE reads as measured when it is a guess.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ColumnArg {
    pub connection: String,
    pub database: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ColumnProfile {
    pub rows_total: i64,
    /// Rows where the column is not null.
    pub rows_present: i64,
    pub nulls: i64,
    pub distinct_values: i64,
    /// As text, whatever the column's type, so the shape of this answer does
    /// not depend on the column being profiled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<String>,
    /// The most common values, where the posture allows values at all. A
    /// top-ten of a column called `email` is row data whatever the tool is
    /// called.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub most_common: Vec<TopValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct TopValue {
    pub value: String,
    pub occurrences: i64,
}

/// A tool failure, phrased for the model that has to do something next.
type Refusal = String;

#[tool_router]
impl SqlPilot {
    pub fn new(workspace: Arc<dyn Workspace>) -> Self {
        Self {
            workspace,
            limits: Limits::default(),
        }
    }

    pub fn with_limits(workspace: Arc<dyn Workspace>, limits: Limits) -> Self {
        Self { workspace, limits }
    }

    /// The connections the user has shared with agents, and on what terms.
    ///
    /// Start here. Nothing else takes a connection name — they take the id
    /// this returns — and a connection missing from this list is one the user
    /// has not shared rather than one that does not exist.
    #[tool(name = "list_connections")]
    pub async fn list_connections(&self) -> Json<Vec<SharedConnection>> {
        let grants = self.workspace.grants();
        let shared: Vec<SharedConnection> = self
            .workspace
            .live_connections()
            .into_iter()
            .filter_map(|connection| {
                let grant = grants.get(&connection.id)?;
                Some(SharedConnection {
                    posture: format!("{:?}", grant.posture).to_lowercase(),
                    databases: grant.databases.clone(),
                    connection,
                })
            })
            .collect();
        Json(shared)
    }

    /// Databases on a connection, with their character set.
    #[tool(name = "list_databases")]
    pub async fn list_databases(
        &self,
        Parameters(ConnectionArg { connection }): Parameters<ConnectionArg>,
    ) -> Result<Json<Vec<Database>>, Refusal> {
        let (facts, _) = self.resolve(&connection)?;
        let grants = self.workspace.grants();
        let grant = grants.get(&facts.id).expect("resolved");
        let databases = self
            .workspace
            .databases(&connection)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            // A grant limited to some databases hides the rest here rather
            // than refusing later, so the agent never plans against a
            // database it will not be allowed to touch.
            .filter(|d| grant.covers(&d.name))
            .map(Database::from)
            .collect();
        Ok(Json(databases))
    }

    /// Tables in a database: engine, approximate row count, size, comment.
    ///
    /// On a large schema prefer `search_schema` — a list of five hundred
    /// tables costs more context than it answers.
    #[tool(name = "list_tables")]
    pub async fn list_tables(
        &self,
        Parameters(DatabaseArg {
            connection,
            database,
        }): Parameters<DatabaseArg>,
    ) -> Result<Json<Vec<Table>>, Refusal> {
        self.resolve_database(&connection, &database)?;
        let tables = self
            .workspace
            .tables(&connection, &database)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Json(tables.into_iter().map(Table::from).collect()))
    }

    /// Everything about one table: columns, keys, indexes, and foreign keys in
    /// both directions.
    #[tool(name = "describe_table")]
    pub async fn describe_table(
        &self,
        Parameters(TableArg {
            connection,
            database,
            table,
        }): Parameters<TableArg>,
    ) -> Result<Json<TableDescription>, Refusal> {
        self.resolve_database(&connection, &database)?;

        let columns = self
            .workspace
            .columns(&connection, &database, &table)
            .await
            .map_err(|e| e.to_string())?;
        let primary_key = columns
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| c.name.clone())
            .collect();
        let columns: Vec<Column> = columns.into_iter().map(Column::from).collect();

        Ok(Json(TableDescription {
            database: database.clone(),
            table: table.clone(),
            columns,
            primary_key,
            indexes: self
                .workspace
                .indexes(&connection, &database, &table)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(Index::from)
                .collect(),
            foreign_keys: self
                .workspace
                .foreign_keys(&connection, &database, &table)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(ForeignKey::from)
                .collect(),
            referenced_by: self
                .workspace
                .referencing_keys(&connection, &database, &table)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(ReferencedBy::from)
                .collect(),
        }))
    }

    /// The `SHOW CREATE` text for a table, view, routine or trigger.
    #[tool(name = "get_ddl")]
    pub async fn get_ddl(
        &self,
        Parameters(DdlArg {
            connection,
            database,
            object,
            kind,
        }): Parameters<DdlArg>,
    ) -> Result<Json<String>, Refusal> {
        self.resolve_database(&connection, &database)?;
        self.workspace
            .ddl(&connection, &database, &object, kind)
            .await
            .map(Json)
            .map_err(|e| e.to_string())
    }

    /// Views, procedures, functions and triggers in a database.
    #[tool(name = "list_objects")]
    pub async fn list_objects(
        &self,
        Parameters(ObjectsArg {
            connection,
            database,
        }): Parameters<ObjectsArg>,
    ) -> Result<Json<Objects>, Refusal> {
        self.resolve_database(&connection, &database)?;

        let routines = self
            .workspace
            .routines(&connection, &database)
            .await
            .map_err(|e| e.to_string())?;

        Ok(Json(Objects {
            views: self
                .workspace
                .views(&connection, &database)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|v| v.name)
                .collect(),
            procedures: routines
                .iter()
                .filter(|r| r.routine_type.eq_ignore_ascii_case("PROCEDURE"))
                .map(|r| r.name.clone())
                .collect(),
            functions: routines
                .iter()
                .filter(|r| r.routine_type.eq_ignore_ascii_case("FUNCTION"))
                .map(|r| r.name.clone())
                .collect(),
            triggers: self
                .workspace
                .triggers(&connection, &database)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|t| t.name)
                .collect(),
        }))
    }

    /// Find tables and columns by name fragment.
    ///
    /// The way to explore a schema you do not know: ask for "customer" and get
    /// the handful of tables and columns that mention it, rather than every
    /// table in the database.
    #[tool(name = "search_schema")]
    pub async fn search_schema(
        &self,
        Parameters(SearchArg {
            connection,
            database,
            fragment,
        }): Parameters<SearchArg>,
    ) -> Result<Json<Vec<Match>>, Refusal> {
        self.resolve_database(&connection, &database)?;
        let matches = self
            .workspace
            .search_schema(
                &connection,
                &database,
                &fragment,
                self.limits.search_matches,
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(Json(matches.into_iter().map(Match::from).collect()))
    }

    /// How a table joins to the rest of the schema.
    ///
    /// Answers "how do I get from orders to customers" without guessing at
    /// column names. Follows foreign keys in both directions.
    #[tool(name = "related_tables")]
    pub async fn related_tables(
        &self,
        Parameters(RelatedArg {
            connection,
            database,
            table,
            depth,
        }): Parameters<RelatedArg>,
    ) -> Result<Json<Vec<Relation>>, Refusal> {
        self.resolve_database(&connection, &database)?;

        // Two hops is already most of a small schema and the walk is
        // breadth-first, so the useful relations come first whatever the cap.
        let depth = depth.unwrap_or(1).clamp(1, 3);
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut frontier = vec![table.clone()];
        let mut relations = Vec::new();
        seen.insert(table.clone());

        for hop in 1..=depth {
            let mut next = Vec::new();
            for current in &frontier {
                for key in self
                    .workspace
                    .foreign_keys(&connection, &database, current)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    relations.push(Relation {
                        from_table: current.clone(),
                        from_columns: key.columns,
                        to_table: key.referenced_table.clone(),
                        to_columns: key.referenced_columns,
                        hops: hop,
                    });
                    if seen.insert(key.referenced_table.clone()) {
                        next.push(key.referenced_table);
                    }
                }
                for key in self
                    .workspace
                    .referencing_keys(&connection, &database, current)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    relations.push(Relation {
                        from_table: key.table.clone(),
                        from_columns: key.columns,
                        to_table: current.clone(),
                        to_columns: key.referenced_columns,
                        hops: hop,
                    });
                    if seen.insert(key.table.clone()) {
                        next.push(key.table);
                    }
                }
            }
            frontier = next;
            if frontier.is_empty() {
                break;
            }
        }

        Ok(Json(relations))
    }

    /// Run one read-only statement.
    ///
    /// Takes a single statement — two are refused, not truncated. What comes
    /// back depends on the connection's data posture, which `list_connections`
    /// reports: a schema-only connection returns the result's shape and no
    /// values.
    #[tool(name = "run_select")]
    pub async fn run_select(
        &self,
        Parameters(SelectArg {
            connection,
            database,
            sql,
            limit,
        }): Parameters<SelectArg>,
    ) -> Result<Json<SelectResult>, Refusal> {
        let (_, policy) = match &database {
            Some(database) => self.resolve_database(&connection, database)?,
            None => self.resolve(&connection)?,
        };

        let statement = single_statement(&sql).map_err(|e| e.to_string())?;
        if statement.class != VerbClass::Read {
            return Err(format!(
                "run_select only runs statements that read. This one is a {}; use run_write or \
                 run_ddl, which go through the user for approval.",
                match statement.class {
                    VerbClass::Write => "write",
                    VerbClass::Ddl => "schema change",
                    _ => "server command",
                }
            ));
        }
        // Belt and braces: a read is always allowed today, but the class is
        // decided in one place and this asks that place rather than assuming.
        if let Decision::Refuse { reason } | Decision::Ask { reason } =
            policy.decide(VerbClass::Read)
        {
            return Err(reason);
        }

        // Three caps meet here: what the model asked for, what the tool will
        // ever return, and what the posture allows. The smallest wins.
        let requested = limit
            .unwrap_or(self.limits.max_rows)
            .min(self.limits.max_rows);
        let allowance = policy.row_allowance(self.limits.sample_rows);
        let effective = match allowance {
            Some(0) => 0,
            Some(allowed) => requested.min(allowed),
            None => requested,
        };

        let result = self
            .workspace
            .run(
                &connection,
                database.as_deref(),
                &statement.sql,
                Some(effective),
            )
            .await
            .map_err(|e| e.to_string())?;

        let row_count = result.rows.len();
        // Which cap actually bit decides what the note says, and the order
        // matters: "the row limit was reached" is misleading advice when the
        // limit was the posture, because raising it is not the caller's to do.
        let capped_by_posture = allowance.is_some_and(|allowed| allowed < requested);
        let note = if effective == 0 {
            Some(policy.no_values_hint())
        } else if capped_by_posture && row_count as u32 >= effective {
            Some(format!(
                "This connection is shared as samples, so at most {effective} rows come back. The \
                 full result may be larger; aggregate in SQL to characterise the rest."
            ))
        } else if result.rows_truncated {
            Some(format!(
                "Stopped at {row_count} rows: {}.",
                match result.truncation_reason {
                    Some(mas_core::models::query::TruncationReason::MemoryGuard) =>
                        "memory ran low mid-fetch, so a larger limit will not help — narrow the \
                         projection or add a WHERE clause",
                    _ => "the row limit was reached",
                }
            ))
        } else {
            None
        };

        Ok(Json(SelectResult {
            columns: result.columns.into_iter().map(ResultColumn::from).collect(),
            rows: if effective == 0 {
                Vec::new()
            } else {
                result
                    .rows
                    .into_iter()
                    .map(|row| row.into_iter().map(cell_to_json).collect())
                    .collect()
            },
            row_count: if effective == 0 { 0 } else { row_count },
            execution_time_ms: result.execution_time_ms,
            note,
        }))
    }
    /// The plan for a statement, as the server sees it.
    ///
    /// The first thing to reach for when a query is slow, and available at
    /// every posture: a plan is about the shape of the work, not the data.
    #[tool(name = "explain")]
    pub async fn explain(
        &self,
        Parameters(ExplainArg {
            connection,
            database,
            sql,
            format,
            analyze,
        }): Parameters<ExplainArg>,
    ) -> Result<Json<Plan>, Refusal> {
        match &database {
            Some(database) => self.resolve_database(&connection, database)?,
            None => self.resolve(&connection)?,
        };
        // One statement, for the same reason as everywhere else. The plan for
        // two statements is not a thing.
        let statement = single_statement(&sql).map_err(|e| e.to_string())?;

        let response = self
            .workspace
            .explain(
                &connection,
                database.as_deref(),
                &statement.sql,
                analyze,
                format
                    .map(ExplainFormat::from)
                    .unwrap_or(ExplainFormat::Classic),
            )
            .await
            .map_err(|e| e.to_string())?;

        // Both of these are cases where the server gave something other than
        // what was asked for. Saying nothing would let a plain plan read as a
        // measurement.
        let mut notes: Vec<String> = Vec::new();
        if let Some(refusal) = &response.refusal {
            notes.push(
                match refusal {
                    AnalyzeRefusal::WouldMutate => {
                        "ANALYZE was not run: it would have applied the statement's changes in \
                         order to time them. This is the planner's estimate."
                    }
                    AnalyzeRefusal::ReadOnlyConnection => {
                        "ANALYZE was not run: this connection is read-only. This is the planner's \
                         estimate."
                    }
                }
                .to_string(),
            );
        }
        if let Some(fallback) = &response.format_fallback {
            match fallback {
                FormatFallback::TreeNotSupported => notes.push(
                    "This server has no tree format, so the tabular plan is what came back."
                        .to_string(),
                ),
                FormatFallback::AnalyzeJsonNotSupported => notes.push(
                    "This server cannot combine ANALYZE with JSON, so the JSON plan has no \
                     measured timings."
                        .to_string(),
                ),
                // MariaDB's own spelling of the same thing. Nothing was lost,
                // so there is nothing to report.
                FormatFallback::None => {}
            }
        }

        Ok(Json(Plan {
            columns: response
                .result
                .columns
                .into_iter()
                .map(ResultColumn::from)
                .collect(),
            rows: response
                .result
                .rows
                .into_iter()
                .map(|row| row.into_iter().map(cell_to_json).collect())
                .collect(),
            analyzed: response.analyzed,
            format: format!("{:?}", response.format).to_lowercase(),
            note: (!notes.is_empty()).then(|| notes.join(" ")),
        }))
    }

    /// Size, row estimate and storage for a table.
    ///
    /// Read from the catalogue, so it costs the same on a table of ten rows
    /// and a table of ten million. The row count is InnoDB's estimate and can
    /// be well out; `run_select` with `COUNT(*)` is the count.
    #[tool(name = "table_stats")]
    pub async fn table_stats(
        &self,
        Parameters(TableArg {
            connection,
            database,
            table,
        }): Parameters<TableArg>,
    ) -> Result<Json<serde_json::Value>, Refusal> {
        self.resolve_database(&connection, &database)?;
        check_identifier(&table)?;

        let result = self
            .workspace
            .run(
                &connection,
                Some(&database),
                &table_stats_sql(&database, &table),
                Some(1),
            )
            .await
            .map_err(|e| e.to_string())?;

        let row =
            result.rows.into_iter().next().ok_or_else(|| {
                format!("There is no table called \"{table}\" in \"{database}\".")
            })?;
        Ok(Json(serde_json::Value::Object(
            result
                .columns
                .into_iter()
                .map(|c| c.name)
                .zip(row.into_iter().map(cell_to_json))
                .collect(),
        )))
    }

    /// What one column contains, without reading it.
    ///
    /// Counts, nulls, distinct values and the extremes, computed in the
    /// database. The most common values are included only where the
    /// connection's posture allows values at all — a top-ten list of a column
    /// called `email` is row data whatever the tool is called.
    #[tool(name = "profile_column")]
    pub async fn profile_column(
        &self,
        Parameters(ColumnArg {
            connection,
            database,
            table,
            column,
        }): Parameters<ColumnArg>,
    ) -> Result<Json<ColumnProfile>, Refusal> {
        let (_, policy) = self.resolve_database(&connection, &database)?;
        check_identifier(&table)?;
        check_identifier(&column)?;

        let result = self
            .workspace
            .run(
                &connection,
                Some(&database),
                &profile_column_sql(&database, &table, &column),
                Some(1),
            )
            .await
            .map_err(|e| e.to_string())?;

        let row = result
            .rows
            .into_iter()
            .next()
            .ok_or_else(|| "The profile query returned nothing at all.".to_string())?;
        let mut cells = row.into_iter();
        let rows_total = as_count(cells.next());
        let rows_present = as_count(cells.next());
        let distinct_values = as_count(cells.next());
        let min = as_text(cells.next());
        let max = as_text(cells.next());

        // Top values are the one part of this that is data rather than a
        // number about data, so they follow the posture.
        let mut most_common = Vec::new();
        let mut note = None;
        if policy.posture.allows_values() {
            let top = self
                .workspace
                .run(
                    &connection,
                    Some(&database),
                    &top_values_sql(&database, &table, &column, TOP_VALUES),
                    Some(TOP_VALUES),
                )
                .await
                .map_err(|e| e.to_string())?;
            most_common = top
                .rows
                .into_iter()
                .map(|row| {
                    let mut cells = row.into_iter();
                    TopValue {
                        value: as_text(cells.next()).unwrap_or_default(),
                        occurrences: as_count(cells.next()),
                    }
                })
                .collect();
        } else {
            note = Some(
                "The most common values are not included: this connection is shared as schema \
                 only. The counts above are computed in the database and do not carry values."
                    .to_string(),
            );
        }

        Ok(Json(ColumnProfile {
            rows_total,
            rows_present,
            nulls: rows_total.saturating_sub(rows_present),
            distinct_values,
            min,
            max,
            most_common,
            note,
        }))
    }
}

/// A connection an agent may use, with the terms attached.
///
/// The posture travels with the connection so a model can see, before it asks
/// for anything, that this one will not return values. Explaining the rule up
/// front is cheaper than refusing four queries.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct SharedConnection {
    #[serde(flatten)]
    pub connection: LiveConnection,
    pub posture: String,
    /// The databases this connection is shared for, when it is not all of them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub databases: Option<Vec<String>>,
}

impl SqlPilot {
    /// Which connection is meant, and what may be done to it.
    fn resolve(&self, connection: &str) -> Result<(ConnectionFacts, ConnectionPolicy), Refusal> {
        let facts = self
            .workspace
            .facts(connection)
            .ok_or_else(|| crate::grants::NotGranted::Connection { name: None }.to_string())?;
        let policy = self
            .workspace
            .grants()
            .policy_for(&facts)
            .map_err(|e| e.to_string())?;
        Ok((facts, policy))
    }

    /// As `resolve`, and the grant covers this database.
    fn resolve_database(
        &self,
        connection: &str,
        database: &str,
    ) -> Result<(ConnectionFacts, ConnectionPolicy), Refusal> {
        let facts = self
            .workspace
            .facts(connection)
            .ok_or_else(|| crate::grants::NotGranted::Connection { name: None }.to_string())?;
        let policy = self
            .workspace
            .grants()
            .policy_for_database(&facts, database)
            .map_err(|e| e.to_string())?;
        Ok((facts, policy))
    }
}

#[tool_handler]
impl ServerHandler for SqlPilot {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "SQLPilot exposes the MySQL and MariaDB connections the user has chosen to share. \
                 Call list_connections first: it reports each connection's id, its environment, \
                 and its data posture, which decides whether row values come back at all. \
                 Explore with search_schema and related_tables rather than listing whole \
                 databases. Statements are taken one at a time. Anything that changes data or \
                 schema is approved by the user in SQLPilot's own window, so an approval prompt \
                 here is not something to work around."
                .to_string(),
        );
        info
    }
}
