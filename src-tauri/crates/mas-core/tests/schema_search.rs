use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::schema::SchemaInspector;
use std::sync::Arc;

/// The two schema questions an agent asks that a person does not.
///
/// A person opens the tree and looks. An agent with a 500-table database can
/// neither list it nor guess at it, so it needs to grep the schema
/// (`search_schema`) and to walk relationships from a table it has found
/// (`get_referencing_keys`). Both go to INFORMATION_SCHEMA, which is where
/// MySQL and MariaDB diverge most often, so both are tested on both.
fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "schema-search".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        // MySQL by default; `MAS_TEST_PORT=13308` runs the same tests against
        // MariaDB.
        port: std::env::var("MAS_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(13306),
        username: "root".to_string(),
        password: "test_root_password".to_string(),
        default_database: Some("test_db".to_string()),
        ssh_config: None,
        ssl_config: None,
        pool_min: 1,
        pool_max: 2,
        read_only: false,
        connect_timeout_secs: None,
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

const DB: &str = "schema_search_probe";

async fn run(pool: &sqlx::MySqlPool, statements: &[String]) {
    for statement in statements {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()))
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

async fn setup(pool: &sqlx::MySqlPool) {
    run(
        pool,
        &[
            format!("DROP DATABASE IF EXISTS `{DB}`"),
            format!("CREATE DATABASE `{DB}`"),
            format!(
                "CREATE TABLE `{DB}`.`customers` (
                    id INT, region CHAR(2), PRIMARY KEY (id, region)
                 )"
            ),
            format!(
                "CREATE TABLE `{DB}`.`orders` (
                    id INT PRIMARY KEY,
                    customer_id INT, customer_region CHAR(2),
                    created_at DATETIME COMMENT 'when it was placed',
                    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id, customer_region)
                        REFERENCES `{DB}`.`customers` (id, region)
                        ON DELETE CASCADE ON UPDATE RESTRICT
                 )"
            ),
            format!(
                "CREATE TABLE `{DB}`.`invoices` (
                    id INT PRIMARY KEY,
                    customer_id INT, customer_region CHAR(2),
                    CONSTRAINT fk_invoices_customer FOREIGN KEY (customer_id, customer_region)
                        REFERENCES `{DB}`.`customers` (id, region)
                        ON DELETE SET NULL ON UPDATE NO ACTION
                 )"
            ),
            // A literal underscore in a name, to catch a LIKE pattern that
            // forgot to escape the fragment.
            format!("CREATE TABLE `{DB}`.`a_b` (id INT PRIMARY KEY)"),
            format!("CREATE TABLE `{DB}`.`axb` (id INT PRIMARY KEY)"),
        ],
    )
    .await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn finds_what_points_at_a_table() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    let keys = inspector
        .get_referencing_keys(&info.id, DB, "customers")
        .await
        .unwrap();

    assert_eq!(keys.len(), 2, "two tables point at customers");

    let orders = keys.iter().find(|k| k.table == "orders").unwrap();
    assert_eq!(orders.name, "fk_orders_customer");
    assert_eq!(
        orders.columns,
        vec!["customer_id", "customer_region"],
        "a composite key keeps key order, not alphabetical order"
    );
    assert_eq!(orders.referenced_columns, vec!["id", "region"]);
    assert_eq!(
        orders.on_delete, "CASCADE",
        "what happens to the far side is the point of asking"
    );
    assert_eq!(orders.on_update, "RESTRICT");

    let invoices = keys.iter().find(|k| k.table == "invoices").unwrap();
    assert_eq!(invoices.on_delete, "SET NULL");

    // The other direction still answers separately: customers depends on
    // nothing, which is why deleting from it is the dangerous one.
    assert!(inspector
        .get_foreign_keys(&info.id, DB, "customers")
        .await
        .unwrap()
        .is_empty());

    run(&pool, &[format!("DROP DATABASE `{DB}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_table_nothing_references_reports_none() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    // An empty list, not an error. "Nothing depends on this" is an answer.
    assert!(inspector
        .get_referencing_keys(&info.id, DB, "orders")
        .await
        .unwrap()
        .is_empty());

    run(&pool, &[format!("DROP DATABASE `{DB}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn searches_table_and_column_names() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    let matches = inspector
        .search_schema(&info.id, DB, "customer", 100)
        .await
        .unwrap();

    // Matched by table name (every column of `customers`) and by column name
    // (`customer_id` in orders and invoices).
    let tables: std::collections::HashSet<_> = matches.iter().map(|m| &m.table).collect();
    assert!(tables.contains(&"customers".to_string()));
    assert!(tables.contains(&"orders".to_string()));
    assert!(tables.contains(&"invoices".to_string()));
    assert!(
        !tables.contains(&"a_b".to_string()),
        "a table with nothing matching should not appear"
    );

    // The type comes back, because the next thing anyone does with a found
    // column is write a comparison against it.
    let region = matches
        .iter()
        .find(|m| m.table == "customers" && m.column == "region")
        .unwrap();
    assert!(region.column_type.to_lowercase().starts_with("char"));

    run(&pool, &[format!("DROP DATABASE `{DB}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn comments_come_back_because_they_are_the_documentation() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    let matches = inspector
        .search_schema(&info.id, DB, "created_at", 100)
        .await
        .unwrap();

    let created = matches.iter().find(|m| m.column == "created_at").unwrap();
    assert_eq!(
        created.comment, "when it was placed",
        "often the only documentation a column has"
    );

    run(&pool, &[format!("DROP DATABASE `{DB}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn an_underscore_in_the_fragment_is_a_character_not_a_wildcard() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    // Unescaped, LIKE '%a_b%' matches `axb` too, and someone searching for
    // `created_at` gets every column with a letter between "created" and "at".
    let matches = inspector
        .search_schema(&info.id, DB, "a_b", 100)
        .await
        .unwrap();
    let tables: std::collections::HashSet<_> = matches.iter().map(|m| m.table.as_str()).collect();

    assert!(tables.contains("a_b"));
    assert!(!tables.contains("axb"), "underscore is not a wildcard here");

    run(&pool, &[format!("DROP DATABASE `{DB}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn the_limit_is_applied_in_the_database() {
    let manager = Arc::new(ConnectionManager::new());
    let inspector = SchemaInspector::new(manager.clone());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    setup(&pool).await;

    // The point of the cap is not to fetch the rest, so that a search on a
    // huge schema costs the same as a search on a small one.
    let matches = inspector
        .search_schema(&info.id, DB, "id", 2)
        .await
        .unwrap();
    assert_eq!(matches.len(), 2);

    run(&pool, &[format!("DROP DATABASE `{DB}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}
