# SQLPilot — Testing Strategy

---

## 1. Testing Philosophy

### Test Pyramid

```
     ╱  E2E  ╲           ← Few, focused, high-value user journeys
    ╱──────────╲
   ╱ Integration ╲       ← Every Tauri command, DB interaction
  ╱────────────────╲
 ╱    Unit Tests     ╲   ← Every function, component, utility
╱──────────────────────╲
```

| Layer        | Target                                     | Tooling                        | Approximate Count |
| ------------ | ------------------------------------------ | ------------------------------ | ----------------- |
| Unit (Rust)  | Pure functions, data models, serialization | `cargo test`                   | 200+              |
| Unit (React) | Components, hooks, utilities               | Vitest + React Testing Library | 300+              |
| Integration  | Tauri commands against real MySQL          | `cargo test` + Docker MySQL    | 100+              |
| E2E          | Full user workflows through the UI         | Playwright + Tauri test driver | 50+               |

### Core Principles

1. **Every Tauri command must have integration tests** — commands are the API boundary; a bug here means a broken feature.
2. **Every UI component must have unit tests** — rendering, props, state, error states.
3. **Every user workflow must have E2E tests** — connect, query, edit, export, admin.
4. **Tests must be deterministic** — no random data, no time-dependent assertions, no flaky waits.
5. **Tests must be isolated** — each test suite operates on its own database or uses transactions that roll back.
6. **Tests must be fast** — unit tests < 30s total, integration tests < 2 min, E2E tests < 10 min.

---

## 2. Testing Infrastructure

### Docker MySQL Test Environment

```yaml
# docker-compose.test.yml
services:
  mysql-8:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: test_root_password
      MYSQL_DATABASE: test_db
      MYSQL_USER: test_user
      MYSQL_PASSWORD: test_password
    ports:
      - "13306:3306"
    volumes:
      - ./tests/fixtures/sql/seed.sql:/docker-entrypoint-initdb.d/01-seed.sql
      - ./tests/fixtures/sql/seed_large.sql:/docker-entrypoint-initdb.d/02-seed-large.sql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      timeout: 3s
      retries: 30

  mysql-5_7:
    image: mysql:5.7
    environment:
      MYSQL_ROOT_PASSWORD: test_root_password
      MYSQL_DATABASE: test_db
    ports:
      - "13307:3306"
    volumes:
      - ./tests/fixtures/sql/seed.sql:/docker-entrypoint-initdb.d/01-seed.sql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      timeout: 3s
      retries: 30

  mariadb-11:
    image: mariadb:11
    environment:
      MYSQL_ROOT_PASSWORD: test_root_password
      MYSQL_DATABASE: test_db
    ports:
      - "13308:3306"
    volumes:
      - ./tests/fixtures/sql/seed.sql:/docker-entrypoint-initdb.d/01-seed.sql
    healthcheck:
      test: ["CMD", "mariadb-admin", "ping", "-h", "localhost"]
      interval: 5s
      timeout: 3s
      retries: 30

  mysql-ssl:
    image: mysql:8.0
    command: >
      --require-secure-transport=ON
      --ssl-ca=/etc/mysql/ssl/ca-cert.pem
      --ssl-cert=/etc/mysql/ssl/server-cert.pem
      --ssl-key=/etc/mysql/ssl/server-key.pem
    environment:
      MYSQL_ROOT_PASSWORD: test_root_password
      MYSQL_DATABASE: test_db
    ports:
      - "13309:3306"
    volumes:
      - ./tests/fixtures/ssl/server-cert.pem:/etc/mysql/ssl/server-cert.pem
      - ./tests/fixtures/ssl/server-key.pem:/etc/mysql/ssl/server-key.pem
      - ./tests/fixtures/ssl/ca-cert.pem:/etc/mysql/ssl/ca-cert.pem
      - ./tests/fixtures/ssl/my.cnf:/etc/mysql/conf.d/ssl.cnf
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      timeout: 3s
      retries: 30

  ssh-server:
    image: lscr.io/linuxserver/openssh-server:latest
    environment:
      - PASSWORD_ACCESS=true
      - USER_PASSWORD=test_ssh_password
      - USER_NAME=test_ssh_user
    ports:
      - "12222:2222"
```

### Container Lifecycle

1. **Before test suite:** `docker compose -f docker-compose.test.yml up -d --wait`
2. **Health check:** Wait for all containers to report healthy.
3. **Seed data:** Applied automatically via `docker-entrypoint-initdb.d/seed.sql`.
4. **Between test suites:** Reset test databases to known state via truncation + re-seed.
5. **After test suite:** `docker compose -f docker-compose.test.yml down -v`

---

## 3. Test Seed Data

### Database Schema

```sql
-- =============================================================================
-- tests/fixtures/seed.sql
-- Comprehensive test database covering all MySQL data types and edge cases
-- =============================================================================

-- ---------------------------------------------------------------------------
-- test_db: Standard test data
-- ---------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS test_db;
USE test_db;

-- Categories (self-referential FK)
CREATE TABLE categories (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    parent_id   INT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
);

-- Users (covers many data types)
CREATE TABLE users (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    username        VARCHAR(50) NOT NULL UNIQUE,
    email           VARCHAR(255) NOT NULL,
    password_hash   BINARY(60) NOT NULL,
    full_name       VARCHAR(200),
    bio             TEXT,
    avatar          BLOB,
    balance         DECIMAL(12,2) DEFAULT 0.00,
    rating          FLOAT DEFAULT 0.0,
    latitude        DOUBLE,
    longitude       DOUBLE,
    status          ENUM('active', 'inactive', 'banned') DEFAULT 'active',
    roles           SET('admin', 'editor', 'viewer') DEFAULT 'viewer',
    preferences     JSON,
    birth_date      DATE,
    last_login      DATETIME,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    INDEX idx_email (email),
    FULLTEXT INDEX ft_bio (bio)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Products
CREATE TABLE products (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    sku             VARCHAR(50) NOT NULL UNIQUE,
    name            VARCHAR(200) NOT NULL,
    description     MEDIUMTEXT,
    price           DECIMAL(10,2) NOT NULL,
    weight_kg       FLOAT,
    category_id     INT,
    metadata        JSON,
    image           MEDIUMBLOB,
    is_active       TINYINT(1) DEFAULT 1,
    stock_count     INT UNSIGNED DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
    INDEX idx_category (category_id),
    INDEX idx_price (price)
) ENGINE=InnoDB;

-- Orders
CREATE TABLE orders (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT NOT NULL,
    order_number    VARCHAR(20) NOT NULL UNIQUE,
    status          ENUM('pending', 'processing', 'shipped', 'delivered', 'cancelled') DEFAULT 'pending',
    total           DECIMAL(12,2) NOT NULL,
    notes           TEXT,
    shipping_address JSON,
    ordered_at      DATETIME NOT NULL,
    shipped_at      DATETIME,
    delivered_at    DATETIME,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user (user_id),
    INDEX idx_status (status),
    INDEX idx_ordered_at (ordered_at)
) ENGINE=InnoDB;

-- Order Items (junction table)
CREATE TABLE order_items (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_id    BIGINT NOT NULL,
    product_id  INT NOT NULL,
    quantity    INT NOT NULL DEFAULT 1,
    unit_price  DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
    INDEX idx_order (order_id),
    INDEX idx_product (product_id)
) ENGINE=InnoDB;

-- All-types reference table (for data type round-trip testing)
CREATE TABLE all_types (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    col_tinyint     TINYINT,
    col_smallint    SMALLINT,
    col_mediumint   MEDIUMINT,
    col_int         INT,
    col_bigint      BIGINT,
    col_float       FLOAT,
    col_double      DOUBLE,
    col_decimal     DECIMAL(20,10),
    col_bit         BIT(8),
    col_char        CHAR(10),
    col_varchar     VARCHAR(255),
    col_tinytext    TINYTEXT,
    col_text        TEXT,
    col_mediumtext  MEDIUMTEXT,
    col_longtext    LONGTEXT,
    col_binary      BINARY(16),
    col_varbinary   VARBINARY(255),
    col_tinyblob    TINYBLOB,
    col_blob        BLOB,
    col_mediumblob  MEDIUMBLOB,
    col_longblob    LONGBLOB,
    col_date        DATE,
    col_time        TIME,
    col_datetime    DATETIME,
    col_timestamp   TIMESTAMP NULL,
    col_year        YEAR,
    col_enum        ENUM('a', 'b', 'c'),
    col_set         SET('x', 'y', 'z'),
    col_json        JSON,
    col_geometry    GEOMETRY
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
CREATE VIEW active_users AS
    SELECT id, username, email, full_name, last_login
    FROM users
    WHERE status = 'active';

CREATE VIEW order_summary AS
    SELECT
        o.id AS order_id,
        o.order_number,
        u.username,
        o.status,
        o.total,
        COUNT(oi.id) AS item_count,
        o.ordered_at
    FROM orders o
    JOIN users u ON o.user_id = u.id
    JOIN order_items oi ON oi.order_id = o.id
    GROUP BY o.id;

-- ---------------------------------------------------------------------------
-- Stored Procedures
-- ---------------------------------------------------------------------------
DELIMITER //

CREATE PROCEDURE get_user_orders(IN p_user_id BIGINT)
BEGIN
    SELECT o.*, COUNT(oi.id) AS item_count
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.user_id = p_user_id
    GROUP BY o.id
    ORDER BY o.ordered_at DESC;
END //

CREATE PROCEDURE create_order(
    IN p_user_id BIGINT,
    IN p_order_number VARCHAR(20),
    IN p_total DECIMAL(12,2),
    OUT p_order_id BIGINT
)
BEGIN
    INSERT INTO orders (user_id, order_number, total, ordered_at)
    VALUES (p_user_id, p_order_number, p_total, NOW());
    SET p_order_id = LAST_INSERT_ID();
END //

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
CREATE FUNCTION calculate_discount(
    p_total DECIMAL(12,2),
    p_percentage DECIMAL(5,2)
) RETURNS DECIMAL(12,2)
DETERMINISTIC
BEGIN
    RETURN p_total * (1 - p_percentage / 100);
END //

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE TRIGGER update_stock_on_order
AFTER INSERT ON order_items
FOR EACH ROW
BEGIN
    UPDATE products
    SET stock_count = stock_count - NEW.quantity
    WHERE id = NEW.product_id;
END //

DELIMITER ;

-- ---------------------------------------------------------------------------
-- Sample Data
-- ---------------------------------------------------------------------------
INSERT INTO categories (name, parent_id) VALUES
    ('Electronics', NULL),
    ('Clothing', NULL),
    ('Phones', 1),
    ('Laptops', 1),
    ('T-Shirts', 2);

INSERT INTO users (username, email, password_hash, full_name, bio, balance, rating, status, roles, preferences, birth_date, last_login) VALUES
    ('alice',   'alice@example.com',   UNHEX(SHA2('password1', 256)), 'Alice Johnson',  'Software engineer from NYC',  1500.50, 4.8, 'active',   'admin,editor', '{"theme":"dark","lang":"en"}', '1990-03-15', '2024-01-15 10:30:00'),
    ('bob',     'bob@example.com',     UNHEX(SHA2('password2', 256)), 'Bob Smith',      'DBA with 10 years experience', 2300.00, 4.2, 'active',   'editor',       '{"theme":"light","lang":"en"}', '1985-07-22', '2024-01-14 08:00:00'),
    ('charlie', 'charlie@example.com', UNHEX(SHA2('password3', 256)), 'Charlie Brown',  NULL,                           0.00,    3.5, 'inactive', 'viewer',       NULL,                           '1995-11-01', NULL),
    ('diana',   'diana@example.com',   UNHEX(SHA2('password4', 256)), 'Diana Prince',   'Database administrator',       5000.75, 4.9, 'active',   'admin',        '{"theme":"dark","lang":"es"}', '1988-06-30', '2024-01-15 14:22:00'),
    ('eve',     'eve@example.com',     UNHEX(SHA2('password5', 256)), 'Eve Wilson',     'Junior developer — learning SQL! 🚀', 100.00, 2.1, 'active', 'viewer', '{"theme":"light","lang":"fr"}', '2000-01-01', '2024-01-10 09:15:00');

INSERT INTO products (sku, name, description, price, weight_kg, category_id, metadata, is_active, stock_count) VALUES
    ('PHONE-001', 'Smartphone X',    'Latest flagship phone',           999.99, 0.18, 3, '{"color":"black","storage":"128GB"}', 1, 500),
    ('PHONE-002', 'Budget Phone Y',  'Affordable smartphone',           299.99, 0.15, 3, '{"color":"white","storage":"64GB"}',  1, 1000),
    ('LAPTOP-001','Pro Laptop 15"',  'Professional laptop for devs',   1999.99, 1.80, 4, '{"ram":"32GB","ssd":"1TB"}',           1, 200),
    ('SHIRT-001', 'Classic T-Shirt', 'Comfortable cotton t-shirt',      29.99, 0.20, 5, '{"sizes":["S","M","L","XL"]}',         1, 5000),
    ('SHIRT-002', 'Premium Polo',    'Premium cotton polo shirt',       59.99, 0.25, 5, NULL,                                   0, 0);

INSERT INTO orders (user_id, order_number, status, total, notes, shipping_address, ordered_at, shipped_at, delivered_at) VALUES
    (1, 'ORD-2024-001', 'delivered',   1029.98, 'Gift wrap please',   '{"street":"123 Main St","city":"NYC","zip":"10001"}',   '2024-01-01 10:00:00', '2024-01-02 08:00:00', '2024-01-05 14:00:00'),
    (1, 'ORD-2024-002', 'shipped',     1999.99, NULL,                 '{"street":"123 Main St","city":"NYC","zip":"10001"}',   '2024-01-10 15:30:00', '2024-01-11 09:00:00', NULL),
    (2, 'ORD-2024-003', 'processing',   329.98, 'Leave at door',     '{"street":"456 Oak Ave","city":"LA","zip":"90001"}',    '2024-01-14 12:00:00', NULL, NULL),
    (4, 'ORD-2024-004', 'pending',       59.99, NULL,                 '{"street":"789 Pine Rd","city":"Chicago","zip":"60601"}','2024-01-15 09:00:00', NULL, NULL),
    (5, 'ORD-2024-005', 'cancelled',    299.99, 'Changed my mind',   '{"street":"321 Elm St","city":"Seattle","zip":"98101"}', '2024-01-13 11:00:00', NULL, NULL);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
    (1, 1, 1, 999.99),
    (1, 4, 1,  29.99),
    (2, 3, 1, 1999.99),
    (3, 2, 1,  299.99),
    (3, 4, 1,   29.99),
    (4, 5, 1,   59.99),
    (5, 2, 1,  299.99);

-- ---------------------------------------------------------------------------
-- test_db_empty: Edge case testing (empty database)
-- ---------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS test_db_empty;

-- ---------------------------------------------------------------------------
-- test_db_large: Performance testing (populated by test setup scripts)
-- ---------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS test_db_large;
```

### Large Dataset Generation

The `test_db_large` database is populated by a separate setup script (`tests/fixtures/generate_large_data.sql` or a Rust/Python script) that:

- Creates a `large_table` with 1,000,000 rows
- Includes varied data types, NULL values, and unicode text
- Creates indexes to enable meaningful performance testing
- Is generated deterministically (seeded PRNG) for reproducibility

---

## 4. Backend Unit Tests (Rust — `cargo test`)

### `connection_tests.rs`

| Test Name                          | Description                                                  | Type        |
| ---------------------------------- | ------------------------------------------------------------ | ----------- |
| `test_create_connection_profile`   | Create a profile struct, serialize to JSON, deserialize back | Unit        |
| `test_connect_mysql8`              | Connect to MySQL 8.0 container on port 13306                 | Integration |
| `test_connect_mysql57`             | Connect to MySQL 5.7 container on port 13307                 | Integration |
| `test_connect_mariadb`             | Connect to MariaDB 11 container on port 13308                | Integration |
| `test_connect_with_ssl`            | Connect to SSL-enabled MySQL on port 13309                   | Integration |
| `test_connect_with_ssh_tunnel`     | Connect through SSH tunnel container on port 12222           | Integration |
| `test_connect_invalid_credentials` | Expect `AccessDenied` error with wrong password              | Integration |
| `test_connect_invalid_host`        | Expect `ConnectionRefused` or timeout with nonexistent host  | Integration |
| `test_connect_timeout`             | Expect timeout error when connecting to unresponsive port    | Integration |
| `test_connection_pool_sizing`      | Verify pool respects `min_connections` and `max_connections` | Integration |
| `test_auto_reconnect`              | Kill connection server-side, verify next query reconnects    | Integration |
| `test_disconnect_cleanup`          | Disconnect and verify pool is drained, resources freed       | Integration |
| `test_concurrent_connections`      | Open 10 connections simultaneously, all succeed              | Integration |

### `query_tests.rs`

| Test Name                         | Description                                                         | Type        |
| --------------------------------- | ------------------------------------------------------------------- | ----------- |
| `test_execute_select`             | `SELECT * FROM users` returns expected columns and rows             | Integration |
| `test_execute_insert`             | `INSERT INTO users (...)` returns affected rows = 1                 | Integration |
| `test_execute_update`             | `UPDATE users SET ...` returns correct affected count               | Integration |
| `test_execute_delete`             | `DELETE FROM users WHERE ...` returns correct affected count        | Integration |
| `test_execute_ddl`                | `CREATE TABLE temp_test (...)` succeeds, table exists               | Integration |
| `test_execute_multi_statement`    | Two SELECT statements return two result sets                        | Integration |
| `test_execute_with_params`        | Parameterized query prevents SQL injection                          | Integration |
| `test_cancel_long_query`          | Cancel `SELECT SLEEP(60)` within 2 seconds                          | Integration |
| `test_query_timeout`              | Query exceeding timeout returns timeout error                       | Integration |
| `test_large_result_set_streaming` | Stream 100K rows without OOM                                        | Integration |
| `test_binary_data_handling`       | Insert and retrieve BLOB data, verify byte equality                 | Integration |
| `test_null_handling`              | NULL values round-trip correctly for all column types               | Integration |
| `test_all_data_types`             | Insert/select all MySQL types via `all_types` table                 | Integration |
| `test_unicode_data`               | Insert and retrieve emoji and CJK characters                        | Integration |
| `test_json_data_type`             | Insert JSON object, query with `JSON_EXTRACT`                       | Integration |
| `test_transaction_commit`         | Begin → Insert → Commit → verify row exists                         | Integration |
| `test_transaction_rollback`       | Begin → Insert → Rollback → verify row absent                       | Integration |
| `test_concurrent_queries`         | Run 10 queries in parallel on same pool, all return correct results | Integration |

### `schema_tests.rs`

| Test Name                        | Description                                                                                | Type        |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ----------- |
| `test_list_databases`            | Returns at least `test_db`, `test_db_empty`, `test_db_large`                               | Integration |
| `test_list_tables`               | `test_db` contains `users`, `orders`, `products`, `categories`, `order_items`, `all_types` | Integration |
| `test_list_views`                | `test_db` contains `active_users`, `order_summary`                                         | Integration |
| `test_list_columns_all_types`    | `all_types` table returns correct column names and types                                   | Integration |
| `test_list_indexes`              | `users` table has PK, `idx_status`, `idx_email`, `ft_bio`                                  | Integration |
| `test_list_foreign_keys`         | `orders.user_id` → `users.id` FK detected                                                  | Integration |
| `test_list_triggers`             | `update_stock_on_order` trigger found on `order_items`                                     | Integration |
| `test_list_procedures`           | `get_user_orders` and `create_order` found                                                 | Integration |
| `test_list_functions`            | `calculate_discount` found with correct parameter types                                    | Integration |
| `test_list_events`               | Events listing works (empty set is valid)                                                  | Integration |
| `test_get_table_ddl`             | `SHOW CREATE TABLE users` returns valid DDL string                                         | Integration |
| `test_schema_cache_invalidation` | Create table → cache miss → schema updated                                                 | Unit        |
| `test_schema_refresh`            | Force refresh clears cache and reloads from server                                         | Integration |

### `export_tests.rs`

| Test Name                             | Description                                                | Type        |
| ------------------------------------- | ---------------------------------------------------------- | ----------- |
| `test_export_csv`                     | Export `users` → valid CSV with headers, correct row count | Integration |
| `test_export_json`                    | Export `users` → valid JSON array of objects               | Integration |
| `test_export_sql_insert`              | Export `users` → valid `INSERT INTO` statements            | Integration |
| `test_export_sql_replace`             | Export `users` → valid `REPLACE INTO` statements           | Integration |
| `test_export_xlsx`                    | Export `users` → valid XLSX file readable by calamine      | Integration |
| `test_export_xml`                     | Export `users` → valid XML document                        | Integration |
| `test_export_markdown`                | Export `users` → valid Markdown table                      | Integration |
| `test_export_large_dataset_streaming` | Export 100K rows to CSV without exceeding 200MB RAM        | Integration |
| `test_import_csv`                     | Import CSV into empty table → verify row count and data    | Integration |
| `test_import_json`                    | Import JSON array into table → verify data                 | Integration |
| `test_import_sql_dump`                | Import SQL dump → verify tables and data created           | Integration |
| `test_import_column_mapping`          | Import CSV with remapped columns → verify correct mapping  | Integration |

### `admin_tests.rs`

| Test Name                    | Description                                                    | Type        |
| ---------------------------- | -------------------------------------------------------------- | ----------- |
| `test_list_users`            | `SELECT user FROM mysql.user` returns results                  | Integration |
| `test_create_user`           | `CREATE USER` succeeds, user appears in user list              | Integration |
| `test_grant_privileges`      | `GRANT SELECT ON test_db.*` succeeds, privilege verified       | Integration |
| `test_revoke_privileges`     | `REVOKE SELECT ON test_db.*` succeeds, privilege removed       | Integration |
| `test_drop_user`             | `DROP USER` succeeds, user absent from user list               | Integration |
| `test_show_process_list`     | `SHOW PROCESSLIST` returns at least current connection         | Integration |
| `test_kill_process`          | Start `SLEEP(60)`, kill its process ID, verify terminated      | Integration |
| `test_show_server_variables` | Returns `version`, `max_connections`, etc.                     | Integration |
| `test_set_server_variable`   | `SET GLOBAL wait_timeout = 300` succeeds, variable changed     | Integration |
| `test_optimize_table`        | `OPTIMIZE TABLE products` returns status                       | Integration |
| `test_repair_table`          | `REPAIR TABLE products` returns status                         | Integration |
| `test_analyze_table`         | `ANALYZE TABLE products` returns status                        | Integration |
| `test_check_table`           | `CHECK TABLE products` returns status                          | Integration |
| `test_create_database`       | `CREATE DATABASE test_temp` succeeds                           | Integration |
| `test_drop_database`         | `DROP DATABASE test_temp` succeeds                             | Integration |
| `test_backup_database`       | Dump `test_db` to SQL file, verify file is non-empty and valid | Integration |
| `test_restore_database`      | Restore dump into fresh database, verify tables and data       | Integration |

### `ai_tests.rs`

| Test Name                                 | Description                                                                   | Type             |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ---------------- |
| `test_generate_sql_from_natural_language` | "List active users" → valid `SELECT` query                                    | Unit (mocked AI) |
| `test_explain_query`                      | Complex JOIN → readable explanation text                                      | Unit (mocked AI) |
| `test_optimize_query_suggestion`          | Query without index → suggests `CREATE INDEX`                                 | Unit (mocked AI) |
| `test_schema_context_building`            | Schema with 10 tables → correctly serialized prompt context under token limit | Unit             |
| `test_rate_limiting`                      | 100 rapid requests → rate limiter queues/rejects appropriately                | Unit             |

---

## 5. Frontend Unit Tests (Vitest + React Testing Library)

### `ConnectionDialog.test.tsx`

| Test                               | Description                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| renders form fields correctly      | Host, port, username, password, database, SSL toggle, SSH toggle all present |
| validates required fields          | Submit with empty host shows validation error                                |
| shows port default                 | Port field defaults to 3306                                                  |
| tests connection on button click   | "Test Connection" calls Tauri command and shows spinner                      |
| shows success feedback             | Successful test shows green checkmark and "Connection successful"            |
| shows error feedback               | Failed test shows red error message with details                             |
| saves profile on submit            | "Save" calls Tauri save command and closes dialog                            |
| loads existing profile for editing | Opening with existing profile pre-fills all fields                           |
| handles SSH tunnel fields          | Enabling SSH toggle reveals SSH host, port, username, key fields             |
| handles SSL fields                 | Enabling SSL toggle reveals CA cert, client cert, client key fields          |

### `SQLEditor.test.tsx`

| Test                            | Description                                                         |
| ------------------------------- | ------------------------------------------------------------------- |
| renders Monaco editor           | Editor container is in the DOM with correct dimensions              |
| executes query on Ctrl+Enter    | Pressing Ctrl+Enter calls execute Tauri command with editor content |
| executes selected text only     | With selection active, Ctrl+Enter sends only selected text          |
| supports multiple tabs          | Renders tab bar with correct tab titles                             |
| switches between tabs           | Clicking a tab shows that tab's editor content                      |
| closes tab                      | Clicking close button removes tab and switches to adjacent          |
| autocomplete triggers on typing | Typing `SELECT * FROM u` shows autocomplete suggestions             |
| formats SQL on command          | Triggering format command reformats SQL in editor                   |
| shows line numbers              | Line number gutter is visible                                       |
| shows error markers             | After query error, editor shows red squiggly on error line          |
| handles read-only mode          | In read-only mode, typing does not modify content                   |

### `DataGrid.test.tsx`

| Test                          | Description                                                |
| ----------------------------- | ---------------------------------------------------------- |
| renders column headers        | Column names from result metadata appear as headers        |
| renders row data              | First page of data rendered in grid cells                  |
| handles empty result set      | Shows "No results" message when query returns zero rows    |
| handles query with no columns | Shows "Query executed successfully" for non-SELECT         |
| sorts on column click         | Clicking column header toggles sort indicator              |
| multi-sort with shift-click   | Shift-clicking adds secondary sort                         |
| filters with search input     | Typing in column filter reduces visible rows               |
| handles inline editing        | Double-clicking a cell enters edit mode                    |
| commits edit on Enter         | Pressing Enter in edit mode saves the value                |
| reverts edit on Escape        | Pressing Escape in edit mode restores original value       |
| copies selected cells         | Ctrl+C on selected cells copies to clipboard               |
| handles NULL display          | NULL values render as styled "NULL" text                   |
| handles boolean display       | TINYINT(1) renders as checkbox or true/false               |
| handles large datasets        | Rendering 10K rows uses virtualization (only ~50 DOM rows) |
| resizes columns               | Dragging column edge changes column width                  |
| reorders columns              | Dragging column header moves column                        |

### `SchemaTree.test.tsx`

| Test                      | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| renders database list     | Shows database names from schema query                        |
| expands database          | Clicking database shows Tables, Views, etc. folders           |
| lazy loads table children | Table columns load on expand, not on initial render           |
| shows loading indicator   | Expanding a node shows spinner while loading                  |
| refreshes on demand       | Clicking refresh re-fetches schema from server                |
| filters objects by search | Typing in search box filters tree nodes                       |
| drag object to editor     | Dragging table name starts drag event with table identifier   |
| context menu on table     | Right-clicking table shows Open, Script as, Drop options      |
| context menu on database  | Right-clicking database shows New Query, Create Table options |
| shows object icons        | Tables, views, procedures have distinct icons                 |

### `AIChat.test.tsx`

| Test                    | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| renders chat panel      | Chat input and message list are present                        |
| sends message           | Typing and pressing Enter sends message to AI service          |
| displays AI response    | AI response renders as Markdown in chat                        |
| streams response        | Tokens appear incrementally during streaming                   |
| inserts SQL into editor | "Insert into editor" button copies generated SQL to active tab |
| shows loading state     | Spinner shown while waiting for AI response                    |
| handles error           | AI error shows user-friendly error message                     |
| clears conversation     | "New chat" button clears message history                       |
| maintains context       | Follow-up messages include conversation history                |

### `StatusBar.test.tsx`

| Test                     | Description                                     |
| ------------------------ | ----------------------------------------------- |
| shows connection name    | Displays active connection profile name         |
| shows disconnected state | Shows "Not connected" when no active connection |
| shows query timing       | After query execution, shows elapsed time in ms |
| shows row count          | After SELECT, shows "N rows returned"           |
| shows affected rows      | After UPDATE/DELETE, shows "N rows affected"    |

### `UserManagement.test.tsx`

| Test                        | Description                                         |
| --------------------------- | --------------------------------------------------- |
| renders user list           | Displays users from MySQL user table                |
| opens create user dialog    | "New User" button opens form                        |
| validates username required | Empty username shows validation error               |
| shows privilege checkboxes  | Privilege matrix renders with correct columns       |
| confirms drop user          | Drop button shows confirmation dialog with username |

### `ExportWizard.test.tsx`

| Test                          | Description                                             |
| ----------------------------- | ------------------------------------------------------- |
| renders format options        | CSV, JSON, SQL, XLSX, XML, Markdown options shown       |
| shows format-specific options | Selecting CSV shows delimiter, encoding options         |
| shows preview                 | Preview section renders first N rows in selected format |
| shows progress                | Progress bar appears during export                      |
| handles completion            | "Export complete" message with file path shown          |

### `ServerDashboard.test.tsx`

| Test                    | Description                                     |
| ----------------------- | ----------------------------------------------- |
| renders metric charts   | QPS, connections, buffer pool charts present    |
| updates on interval     | Charts update with new data on refresh interval |
| handles connection loss | Shows error state when connection drops         |
| pauses auto-refresh     | Pause button stops metric updates               |

---

## 6. End-to-End Tests (Playwright + Tauri)

### E2E Test Setup

```typescript
// tests/e2e/global-setup.ts
import { execSync } from "child_process";

export default async function globalSetup() {
  // 1. Start Docker MySQL containers
  execSync("docker compose -f docker-compose.test.yml up -d --wait", {
    timeout: 120_000,
  });

  // 2. Wait for all health checks
  await waitForMySQL(13306); // MySQL 8.0
  await waitForMySQL(13307); // MySQL 5.7
  await waitForMySQL(13308); // MariaDB 11
  await waitForMySQL(13309); // MySQL SSL

  // 3. Seed test data (handled by docker-entrypoint-initdb.d)
  console.log("All MySQL containers healthy and seeded.");
}

export async function globalTeardown() {
  execSync("docker compose -f docker-compose.test.yml down -v");
}
```

### E2E Test Suites

#### `connection.e2e.ts`

| Test                            | Steps                                                                 | Expected Result                             |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| Create and connect to MySQL 8   | Open connection dialog → fill in host/port/user/pass → Save → Connect | Status bar shows "Connected to MySQL 8.0"   |
| Create and connect to MySQL 5.7 | Same as above with port 13307                                         | Status bar shows "Connected to MySQL 5.7"   |
| Create and connect to MariaDB   | Same as above with port 13308                                         | Status bar shows "Connected to MariaDB 11"  |
| Test SSH tunnel connection      | Fill SSH tunnel fields → Connect                                      | Connection established through tunnel       |
| Test SSL connection             | Enable SSL → provide certs → Connect                                  | SSL indicator visible in status bar         |
| Invalid credentials             | Enter wrong password → Connect                                        | Error message: "Access denied for user..."  |
| Edit existing connection        | Right-click connection → Edit → change port → Save                    | Profile updated, reconnects on new port     |
| Delete connection               | Right-click connection → Delete → Confirm                             | Connection removed from sidebar             |
| Test connection before saving   | Click "Test Connection" in dialog                                     | Green checkmark and "Connection successful" |
| Auto-reconnect                  | Connect → kill connection server-side → execute query                 | Query succeeds after brief reconnection     |

#### `query-editor.e2e.ts`

| Test                     | Steps                                          | Expected Result                            |
| ------------------------ | ---------------------------------------------- | ------------------------------------------ |
| Open new query tab       | Click "+" tab button                           | New empty editor tab appears               |
| Execute SELECT query     | Type `SELECT * FROM users;` → Ctrl+Enter       | Results grid shows 5 user rows             |
| Execute multi-statement  | Type two SELECTs separated by `;` → Ctrl+Enter | Two result set tabs appear                 |
| Cancel running query     | Execute `SELECT SLEEP(60);` → click Cancel     | Query cancelled, editor ready              |
| View EXPLAIN plan        | Select query → click "Explain"                 | EXPLAIN results shown in panel             |
| Format SQL               | Type unformatted SQL → Ctrl+Shift+F            | SQL reformatted with proper indentation    |
| Table name autocomplete  | Type `SELECT * FROM u` → trigger autocomplete  | `users` appears in suggestion list         |
| Column name autocomplete | Type `SELECT users.` → trigger autocomplete    | Column names appear in suggestion list     |
| Query with error         | Execute `SELECTT * FROM users;`                | Error message with line/column information |
| Query history            | Execute 3 queries → open history               | All 3 queries listed with timestamps       |
| Save query as favorite   | Right-click query → Save as favorite → name it | Query appears in favorites panel           |

#### `data-grid.e2e.ts`

| Test                       | Steps                                          | Expected Result                            |
| -------------------------- | ---------------------------------------------- | ------------------------------------------ |
| Large result set scrolling | Query 100K rows → scroll to bottom             | Smooth scroll, last row visible            |
| Sort by column             | Click "username" header                        | Rows sorted alphabetically by username     |
| Filter data                | Enter "alice" in username filter               | Only Alice's row visible                   |
| Edit cell inline           | Double-click email cell → change value → Enter | Cell updated, UPDATE executed on server    |
| Insert new row             | Click "+" button → fill fields → Submit        | New row appears, INSERT executed           |
| Delete row                 | Select row → click Delete → Confirm            | Row removed, DELETE executed               |
| Copy as INSERT             | Select row → right-click → Copy as INSERT      | Clipboard contains valid INSERT statement  |
| Copy as CSV                | Select rows → Ctrl+C                           | Clipboard contains CSV-formatted data      |
| Export to CSV              | Click Export → CSV → Save                      | CSV file saved with correct data           |
| Export to JSON             | Click Export → JSON → Save                     | JSON file saved with correct data          |
| NULL value display         | Query row with NULL bio                        | Cell shows styled "NULL" text              |
| BLOB display               | Query row with avatar BLOB                     | Cell shows "(BLOB: N bytes)" with download |
| JSON display               | Click JSON cell → expand                       | Formatted JSON viewer appears              |

#### `schema-browser.e2e.ts`

| Test                         | Steps                                                     | Expected Result                                     |
| ---------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| Browse databases             | Connect → expand schema tree                              | `test_db`, `test_db_empty`, `test_db_large` visible |
| Browse tables                | Expand `test_db` → Tables                                 | `users`, `orders`, `products`, etc. listed          |
| Browse views                 | Expand `test_db` → Views                                  | `active_users`, `order_summary` listed              |
| Browse procedures            | Expand `test_db` → Procedures                             | `get_user_orders`, `create_order` listed            |
| View table structure         | Click `users` table → Structure tab                       | All columns with types, keys, defaults shown        |
| View table indexes           | Click `users` table → Indexes tab                         | PK, `idx_status`, `idx_email`, `ft_bio` shown       |
| View foreign keys            | Click `orders` table → Foreign Keys tab                   | `user_id → users.id` relationship shown             |
| Create new table             | Right-click database → New Table → fill fields → Apply    | Table created, appears in tree                      |
| Alter table                  | Right-click table → Alter → add column → Apply            | Column added to table                               |
| Drop table with confirmation | Right-click temp table → Drop → type table name → Confirm | Table removed from tree                             |
| Drag table to editor         | Drag `users` from tree into editor                        | `` `users` `` inserted at cursor position           |
| Refresh schema tree          | Click refresh button                                      | Tree reloads from server                            |
| Search schema objects        | Type "user" in search box                                 | `users` table and `active_users` view shown         |

#### `admin.e2e.ts`

| Test                  | Steps                                                   | Expected Result                                 |
| --------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| View process list     | Open Admin → Process List                               | At least one process (current connection) shown |
| Kill a process        | Start `SLEEP(60)` in another tab → Kill in process list | Process terminated, status updates              |
| View server variables | Open Admin → Server Variables                           | Variables listed with values                    |
| Create database user  | Open Admin → Users → Create → fill form → Apply         | User created, appears in user list              |
| Grant privileges      | Select user → Grant SELECT on test_db → Apply           | Privilege granted, verified in privilege list   |
| Revoke privileges     | Select user → Revoke SELECT → Apply                     | Privilege revoked                               |
| Drop user             | Select temp user → Drop → Confirm                       | User removed from list                          |
| Create database       | Open Admin → right-click → New Database → name it       | Database created, appears in tree               |
| Drop database         | Right-click temp database → Drop → type name → Confirm  | Database removed                                |
| Table maintenance     | Select table → Optimize → Run                           | Operation completes with status message         |
| Backup database       | Open Admin → Backup → select `test_db` → Run            | Dump file created with valid SQL                |
| Restore from backup   | Open Admin → Restore → select dump file → Run           | Data restored to target database                |

#### `ai-features.e2e.ts`

| Test                        | Steps                                               | Expected Result                            |
| --------------------------- | --------------------------------------------------- | ------------------------------------------ |
| Generate SQL from NL        | Open AI chat → type "Show all active users" → Send  | Valid SELECT query generated               |
| Insert generated SQL        | Click "Insert into editor" on generated SQL         | SQL appears in active editor tab           |
| Explain a query             | Select JOIN query in editor → click "Explain"       | Human-readable explanation in AI panel     |
| Get optimization suggestion | Select unindexed query → click "Optimize"           | Suggestion card with recommended index     |
| AI chat conversation        | Send follow-up message referencing previous context | AI response considers conversation history |

#### `import-export.e2e.ts`

| Test                 | Steps                                           | Expected Result                             |
| -------------------- | ----------------------------------------------- | ------------------------------------------- |
| Export table to CSV  | Right-click `users` → Export → CSV → Save       | Valid CSV file with headers and 5 data rows |
| Export table to JSON | Right-click `users` → Export → JSON → Save      | Valid JSON array with 5 objects             |
| Export table to SQL  | Right-click `users` → Export → SQL → Save       | Valid INSERT statements                     |
| Import CSV           | Open Import → select CSV → map columns → Import | Data inserted into target table             |
| Import JSON          | Open Import → select JSON → map fields → Import | Data inserted into target table             |
| Import SQL dump      | Open Import → select SQL file → Import          | Tables and data created                     |

#### `performance.e2e.ts`

| Test                        | Steps                                              | Expected Result                      |
| --------------------------- | -------------------------------------------------- | ------------------------------------ |
| Query 100K rows             | Execute SELECT on large table → measure time       | Results displayed in < 3 seconds     |
| Scroll large result set     | Scroll through 100K rows → measure FPS             | Maintains ≥ 30 FPS throughout        |
| Sequential query throughput | Execute 100 simple SELECTs → measure total time    | Completes in < 30 seconds            |
| Multi-tab memory            | Open 10 editor tabs with results → measure memory  | Memory stays under 500MB             |
| Concurrent connections      | Connect to 5 databases simultaneously → query each | All queries succeed within 5 seconds |

---

## 7. Performance Benchmarks

### Benchmark Suite

| Metric                       | Measurement Method                              | Target              |
| ---------------------------- | ----------------------------------------------- | ------------------- |
| **Cold startup time**        | Time from process launch to first paint         | < 1.5 seconds       |
| **Warm startup time**        | Time from process launch with cached state      | < 0.8 seconds       |
| **Connection establishment** | Time from "Connect" click to "Connected" status | < 2 seconds (local) |
| **Simple query latency**     | `SELECT 1` round-trip time                      | < 50ms              |
| **Complex query rendering**  | 10K-row result set fully rendered               | < 500ms             |
| **Large query streaming**    | 100K-row result set fully streamed              | < 3 seconds         |
| **Data grid FPS**            | Scrolling through 100K rows                     | ≥ 60 FPS            |
| **Schema tree loading**      | Load schema for database with 200 tables        | < 2 seconds         |
| **Export throughput**        | Export 100K rows to CSV                         | < 5 seconds         |
| **Memory (idle)**            | Memory usage with one connection, no query      | < 100MB             |
| **Memory (active)**          | Memory with 5 tabs, 10K rows each               | < 300MB             |
| **Memory (stress)**          | Memory with 10 tabs, 100K rows visible          | < 500MB             |

### Benchmark Tooling

- **Rust:** `criterion` benchmarks in `benches/` directory
- **Frontend:** Lighthouse performance audits, custom performance marks via `performance.measure()`
- **E2E:** Playwright's `page.evaluate(() => performance.now())` for timing measurements
- **Memory:** Process memory via `process.memoryUsage()` (Chromium) and Tauri system info

---

## 8. CI/CD Testing Pipeline

```yaml
# .github/workflows/test.yml
name: Test Suite

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  CARGO_TERM_COLOR: always
  RUSTFLAGS: "-D warnings"

jobs:
  rust-tests:
    name: Rust Tests (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]

    services:
      mysql-8:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: test_root_password
          MYSQL_DATABASE: test_db
        ports:
          - 13306:3306
        options: >-
          --health-cmd="mysqladmin ping -h localhost"
          --health-interval=5s
          --health-timeout=3s
          --health-retries=10

    steps:
      - uses: actions/checkout@v4

      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy

      - name: Cache cargo registry
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            target
          key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}

      - name: Run rustfmt check
        run: cargo fmt --all -- --check

      - name: Run clippy
        run: cargo clippy --all-targets --all-features -- -D warnings

      - name: Run unit tests
        run: cargo test --lib --all

      - name: Run integration tests
        run: cargo test --test '*' --all
        env:
          TEST_MYSQL_HOST: localhost
          TEST_MYSQL_PORT: 13306
          TEST_MYSQL_USER: root
          TEST_MYSQL_PASSWORD: test_root_password

  frontend-tests:
    name: Frontend Tests
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Run ESLint
        run: npm run lint

      - name: Run Prettier check
        run: npm run format:check

      - name: Run Vitest
        run: npm run test -- --coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info

  e2e-tests:
    name: E2E Tests
    runs-on: ubuntu-latest
    needs: [rust-tests, frontend-tests]

    steps:
      - uses: actions/checkout@v4

      - name: Install system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Start Docker services
        run: docker compose -f docker-compose.test.yml up -d --wait

      - name: Build Tauri app (test mode)
        run: npm run tauri build -- --debug
        env:
          TAURI_TEST_MODE: true

      - name: Run Playwright E2E tests
        run: npx playwright test
        env:
          TEST_MYSQL_HOST: localhost
          TEST_MYSQL_PORT: 13306

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/

      - name: Stop Docker services
        if: always()
        run: docker compose -f docker-compose.test.yml down -v
```

---

## 9. Test Data Management

### Principles

1. **Deterministic:** All test data is defined in `seed.sql` — no random generation.
2. **Isolated:** Each test suite uses its own database or wraps operations in transactions.
3. **Repeatable:** Running tests twice produces the same results.
4. **Minimal:** Just enough data to exercise the feature; not a data warehouse.

### File Structure

```
tests/
├── fixtures/
│   ├── seed.sql                    # Main seed data (auto-loaded by Docker)
│   ├── generate_large_data.sql     # Script to populate test_db_large
│   ├── ssl/
│   │   ├── ca.pem                  # Test CA certificate
│   │   ├── server-cert.pem         # Test server certificate
│   │   ├── server-key.pem          # Test server key
│   │   ├── client-cert.pem         # Test client certificate
│   │   └── client-key.pem          # Test client key
│   └── import/
│       ├── sample.csv              # Test CSV for import tests
│       ├── sample.json             # Test JSON for import tests
│       └── sample.sql              # Test SQL dump for import tests
├── rust/
│   ├── connection_tests.rs
│   ├── query_tests.rs
│   ├── schema_tests.rs
│   ├── export_tests.rs
│   ├── admin_tests.rs
│   └── ai_tests.rs
├── frontend/
│   ├── components/
│   │   ├── ConnectionDialog.test.tsx
│   │   ├── SQLEditor.test.tsx
│   │   ├── DataGrid.test.tsx
│   │   ├── SchemaTree.test.tsx
│   │   ├── AIChat.test.tsx
│   │   ├── StatusBar.test.tsx
│   │   ├── UserManagement.test.tsx
│   │   ├── ExportWizard.test.tsx
│   │   └── ServerDashboard.test.tsx
│   └── setup.ts                    # Vitest global setup
└── e2e/
    ├── global-setup.ts             # Docker startup/teardown
    ├── connection.e2e.ts
    ├── query-editor.e2e.ts
    ├── data-grid.e2e.ts
    ├── schema-browser.e2e.ts
    ├── admin.e2e.ts
    ├── ai-features.e2e.ts
    ├── import-export.e2e.ts
    └── performance.e2e.ts
```

### Cleanup Strategy

| Scope                    | Strategy                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| Between individual tests | Transaction rollback where possible; otherwise, targeted `DELETE` |
| Between test suites      | Drop and recreate test databases from seed                        |
| After full test run      | `docker compose down -v` removes all containers and volumes       |
| CI environment           | Fresh Docker containers on every run (no persistent state)        |
