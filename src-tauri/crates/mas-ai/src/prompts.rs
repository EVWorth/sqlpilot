use crate::models::ChatMessage;

const MYSQL_EXPERT_SYSTEM: &str = "\
You are an expert MySQL database assistant. You help users write, understand, \
optimize, and debug MySQL queries. You have deep knowledge of MySQL syntax, \
performance tuning, indexing strategies, and best practices. \
Always respond with clear, well-formatted SQL when applicable. \
When writing SQL, use proper MySQL syntax and formatting.";

fn system_msg(content: &str) -> ChatMessage {
    ChatMessage {
        role: "system".to_string(),
        content: content.to_string(),
    }
}

fn user_msg(content: &str) -> ChatMessage {
    ChatMessage {
        role: "user".to_string(),
        content: content.to_string(),
    }
}

pub fn build_nl_to_sql(
    user_prompt: &str,
    schema_context: &str,
    database_name: &str,
) -> Vec<ChatMessage> {
    let system = format!(
        "{}\n\n\
        You are working with a MySQL database named `{}`. \
        Generate only the SQL query that answers the user's request. \
        Do not include explanations unless asked. \
        Return raw SQL without markdown code fences.\n\n\
        Available schema:\n{}",
        MYSQL_EXPERT_SYSTEM, database_name, schema_context
    );

    vec![system_msg(&system), user_msg(user_prompt)]
}

pub fn build_explain_query(sql: &str) -> Vec<ChatMessage> {
    let system = format!(
        "{}\n\n\
        Explain the following SQL query in clear, concise terms. \
        Describe what each clause does, what data it retrieves or modifies, \
        and any important considerations.",
        MYSQL_EXPERT_SYSTEM
    );

    let user = format!("Explain this SQL query:\n\n```sql\n{}\n```", sql);

    vec![system_msg(&system), user_msg(&user)]
}

pub fn build_optimize_query(sql: &str, schema_context: &str) -> Vec<ChatMessage> {
    let system = format!(
        "{}\n\n\
        Analyze the following SQL query for performance issues and suggest optimizations. \
        Consider indexing, query structure, joins, and MySQL-specific optimizations. \
        If schema context is provided, use it to make specific recommendations.\n\n\
        {}",
        MYSQL_EXPERT_SYSTEM,
        if schema_context.is_empty() {
            String::new()
        } else {
            format!("Available schema:\n{}", schema_context)
        }
    );

    let user = format!("Optimize this SQL query:\n\n```sql\n{}\n```", sql);

    vec![system_msg(&system), user_msg(&user)]
}

pub fn build_fix_error(sql: &str, error_message: &str) -> Vec<ChatMessage> {
    let system = format!(
        "{}\n\n\
        The user has a SQL query that produced an error. \
        Analyze the error, explain what went wrong, and provide a corrected version of the query. \
        Return the fixed SQL without markdown code fences.",
        MYSQL_EXPERT_SYSTEM
    );

    let user = format!(
        "Fix this SQL query that produced an error:\n\n\
        Query:\n```sql\n{}\n```\n\n\
        Error:\n{}",
        sql, error_message
    );

    vec![system_msg(&system), user_msg(&user)]
}
