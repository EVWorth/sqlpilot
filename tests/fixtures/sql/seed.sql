-- MySQL AI Studio Test Seed Data
-- Covers all MySQL data types, relationships, views, procedures, functions, triggers, events

-- ============================================
-- SCHEMA: test_db (auto-created by Docker)
-- ============================================

USE test_db;

-- ============================================
-- TABLES
-- ============================================

CREATE TABLE IF NOT EXISTS categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    parent_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    cost DECIMAL(10,2),
    weight FLOAT,
    category_id INT,
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSON,
    image MEDIUMBLOB,
    tags SET('new', 'sale', 'featured', 'clearance'),
    status ENUM('draft', 'active', 'discontinued') DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
    INDEX idx_category (category_id),
    INDEX idx_status (status),
    FULLTEXT INDEX idx_search (name, description)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash CHAR(60) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    date_of_birth DATE,
    avatar BLOB,
    bio MEDIUMTEXT,
    settings JSON,
    role ENUM('admin', 'manager', 'user', 'viewer') DEFAULT 'user',
    is_active BOOLEAN DEFAULT TRUE,
    last_login DATETIME,
    login_count INT UNSIGNED DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_email (email),
    INDEX idx_role (role),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_number VARCHAR(20) NOT NULL UNIQUE,
    user_id BIGINT NOT NULL,
    status ENUM('pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded') DEFAULT 'pending',
    subtotal DECIMAL(12,2) NOT NULL,
    tax DECIMAL(10,2) DEFAULT 0.00,
    shipping DECIMAL(10,2) DEFAULT 0.00,
    total DECIMAL(12,2) NOT NULL,
    currency CHAR(3) DEFAULT 'USD',
    shipping_address JSON,
    billing_address JSON,
    notes TEXT,
    ordered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    shipped_at DATETIME,
    delivered_at DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_user (user_id),
    INDEX idx_status (status),
    INDEX idx_ordered (ordered_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_items (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT NOT NULL,
    product_id INT NOT NULL,
    quantity INT UNSIGNED NOT NULL DEFAULT 1,
    unit_price DECIMAL(10,2) NOT NULL,
    total_price DECIMAL(12,2) NOT NULL,
    discount_percent DECIMAL(5,2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
    INDEX idx_order (order_id),
    INDEX idx_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    table_name VARCHAR(64) NOT NULL,
    record_id BIGINT NOT NULL,
    action ENUM('INSERT', 'UPDATE', 'DELETE') NOT NULL,
    old_values JSON,
    new_values JSON,
    user_id BIGINT,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_table_record (table_name, record_id),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Table with all MySQL data types for testing
CREATE TABLE IF NOT EXISTS data_types_test (
    id INT AUTO_INCREMENT PRIMARY KEY,
    -- Integer types
    col_tinyint TINYINT,
    col_smallint SMALLINT,
    col_mediumint MEDIUMINT,
    col_int INT,
    col_bigint BIGINT,
    col_unsigned_int INT UNSIGNED,
    -- Decimal types
    col_decimal DECIMAL(10,4),
    col_float FLOAT,
    col_double DOUBLE,
    -- String types
    col_char CHAR(10),
    col_varchar VARCHAR(255),
    col_tinytext TINYTEXT,
    col_text TEXT,
    col_mediumtext MEDIUMTEXT,
    col_longtext LONGTEXT,
    -- Binary types
    col_binary BINARY(16),
    col_varbinary VARBINARY(255),
    col_tinyblob TINYBLOB,
    col_blob BLOB,
    col_mediumblob MEDIUMBLOB,
    col_longblob LONGBLOB,
    -- Date/time types
    col_date DATE,
    col_time TIME,
    col_datetime DATETIME,
    col_timestamp TIMESTAMP NULL,
    col_year YEAR,
    -- Other types
    col_enum ENUM('a', 'b', 'c'),
    col_set SET('x', 'y', 'z'),
    col_json JSON,
    col_boolean BOOLEAN,
    col_bit BIT(8)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Table for unicode/encoding tests
CREATE TABLE IF NOT EXISTS unicode_test (
    id INT AUTO_INCREMENT PRIMARY KEY,
    content_latin VARCHAR(255) CHARACTER SET latin1,
    content_utf8 VARCHAR(255) CHARACTER SET utf8mb4,
    content_emoji TEXT CHARACTER SET utf8mb4
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================
-- VIEWS
-- ============================================

CREATE OR REPLACE VIEW active_users AS
SELECT id, username, email, first_name, last_name, role, last_login, login_count
FROM users
WHERE is_active = TRUE;

CREATE OR REPLACE VIEW order_summary AS
SELECT
    o.id AS order_id,
    o.order_number,
    u.username,
    u.email,
    o.status,
    COUNT(oi.id) AS item_count,
    o.subtotal,
    o.tax,
    o.shipping,
    o.total,
    o.ordered_at
FROM orders o
JOIN users u ON o.user_id = u.id
LEFT JOIN order_items oi ON o.id = oi.order_id
GROUP BY o.id;

CREATE OR REPLACE VIEW product_catalog AS
SELECT
    p.id,
    p.sku,
    p.name,
    p.price,
    c.name AS category_name,
    p.status,
    p.tags,
    p.is_active
FROM products p
LEFT JOIN categories c ON p.category_id = c.id
WHERE p.status = 'active';

-- ============================================
-- STORED PROCEDURES
-- ============================================

DELIMITER //

CREATE PROCEDURE IF NOT EXISTS get_user_orders(IN p_user_id BIGINT)
BEGIN
    SELECT o.*, COUNT(oi.id) as item_count
    FROM orders o
    LEFT JOIN order_items oi ON o.id = oi.order_id
    WHERE o.user_id = p_user_id
    GROUP BY o.id
    ORDER BY o.ordered_at DESC;
END //

CREATE PROCEDURE IF NOT EXISTS create_order(
    IN p_user_id BIGINT,
    IN p_product_ids JSON,
    IN p_quantities JSON,
    OUT p_order_id BIGINT
)
BEGIN
    DECLARE v_subtotal DECIMAL(12,2) DEFAULT 0;
    DECLARE v_order_number VARCHAR(20);
    DECLARE i INT DEFAULT 0;
    DECLARE v_count INT;
    DECLARE v_product_id INT;
    DECLARE v_quantity INT;
    DECLARE v_price DECIMAL(10,2);

    SET v_order_number = CONCAT('ORD-', DATE_FORMAT(NOW(), '%Y%m%d'), '-', LPAD(FLOOR(RAND() * 10000), 4, '0'));
    SET v_count = JSON_LENGTH(p_product_ids);

    START TRANSACTION;

    INSERT INTO orders (order_number, user_id, subtotal, total)
    VALUES (v_order_number, p_user_id, 0, 0);

    SET p_order_id = LAST_INSERT_ID();

    WHILE i < v_count DO
        SET v_product_id = JSON_EXTRACT(p_product_ids, CONCAT('$[', i, ']'));
        SET v_quantity = JSON_EXTRACT(p_quantities, CONCAT('$[', i, ']'));

        SELECT price INTO v_price FROM products WHERE id = v_product_id;

        INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price)
        VALUES (p_order_id, v_product_id, v_quantity, v_price, v_price * v_quantity);

        SET v_subtotal = v_subtotal + (v_price * v_quantity);
        SET i = i + 1;
    END WHILE;

    UPDATE orders SET subtotal = v_subtotal, total = v_subtotal WHERE id = p_order_id;

    COMMIT;
END //

CREATE PROCEDURE IF NOT EXISTS search_products(
    IN p_search_term VARCHAR(255),
    IN p_category_id INT,
    IN p_min_price DECIMAL(10,2),
    IN p_max_price DECIMAL(10,2),
    IN p_limit INT,
    IN p_offset INT
)
BEGIN
    SELECT p.*, c.name AS category_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE (p_search_term IS NULL OR MATCH(p.name, p.description) AGAINST(p_search_term IN BOOLEAN MODE))
    AND (p_category_id IS NULL OR p.category_id = p_category_id)
    AND (p_min_price IS NULL OR p.price >= p_min_price)
    AND (p_max_price IS NULL OR p.price <= p_max_price)
    AND p.is_active = TRUE
    ORDER BY p.name
    LIMIT p_limit OFFSET p_offset;
END //

-- ============================================
-- FUNCTIONS
-- ============================================

CREATE FUNCTION IF NOT EXISTS calculate_discount(
    p_price DECIMAL(10,2),
    p_discount_percent DECIMAL(5,2)
) RETURNS DECIMAL(10,2)
DETERMINISTIC
BEGIN
    RETURN ROUND(p_price * (1 - p_discount_percent / 100), 2);
END //

CREATE FUNCTION IF NOT EXISTS get_order_status_label(
    p_status VARCHAR(20)
) RETURNS VARCHAR(50)
DETERMINISTIC
BEGIN
    RETURN CASE p_status
        WHEN 'pending' THEN '⏳ Pending'
        WHEN 'processing' THEN '🔄 Processing'
        WHEN 'shipped' THEN '📦 Shipped'
        WHEN 'delivered' THEN '✅ Delivered'
        WHEN 'cancelled' THEN '❌ Cancelled'
        WHEN 'refunded' THEN '💰 Refunded'
        ELSE '❓ Unknown'
    END;
END //

-- ============================================
-- TRIGGERS
-- ============================================

CREATE TRIGGER IF NOT EXISTS users_after_update
AFTER UPDATE ON users
FOR EACH ROW
BEGIN
    IF OLD.email != NEW.email OR OLD.role != NEW.role THEN
        INSERT INTO audit_log (table_name, record_id, action, old_values, new_values)
        VALUES ('users', NEW.id, 'UPDATE',
            JSON_OBJECT('email', OLD.email, 'role', OLD.role),
            JSON_OBJECT('email', NEW.email, 'role', NEW.role));
    END IF;
END //

CREATE TRIGGER IF NOT EXISTS orders_after_insert
AFTER INSERT ON orders
FOR EACH ROW
BEGIN
    INSERT INTO audit_log (table_name, record_id, action, new_values)
    VALUES ('orders', NEW.id, 'INSERT',
        JSON_OBJECT('order_number', NEW.order_number, 'user_id', NEW.user_id, 'total', NEW.total));
END //

DELIMITER ;

-- ============================================
-- EVENTS
-- ============================================

SET GLOBAL event_scheduler = ON;

-- Note: Events may fail silently in test containers, which is fine
-- CREATE EVENT IF NOT EXISTS cleanup_old_audit_logs
-- ON SCHEDULE EVERY 1 DAY
-- DO DELETE FROM audit_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);

-- ============================================
-- SEED DATA
-- ============================================

-- Categories
INSERT INTO categories (name, description) VALUES
('Electronics', 'Electronic devices and components'),
('Clothing', 'Apparel and accessories'),
('Books', 'Physical and digital books'),
('Home & Garden', 'Home improvement and garden supplies'),
('Sports', 'Sports equipment and accessories');

INSERT INTO categories (name, description, parent_id) VALUES
('Smartphones', 'Mobile phones and accessories', 1),
('Laptops', 'Portable computers', 1),
('T-Shirts', 'Casual wear', 2),
('Fiction', 'Fiction books', 3),
('Non-Fiction', 'Non-fiction books', 3);

-- Products
INSERT INTO products (sku, name, description, price, cost, weight, category_id, status, tags, metadata) VALUES
('ELEC-001', 'Wireless Mouse', 'Ergonomic wireless mouse with USB receiver', 29.99, 12.50, 0.15, 1, 'active', 'new,featured', '{"color": "black", "dpi": 1600, "battery": "AA"}'),
('ELEC-002', 'Mechanical Keyboard', 'RGB mechanical keyboard with Cherry MX switches', 89.99, 45.00, 0.85, 1, 'active', 'featured', '{"switches": "Cherry MX Blue", "layout": "full", "backlight": "RGB"}'),
('ELEC-003', 'USB-C Hub', '7-in-1 USB-C hub with HDMI', 49.99, 22.00, 0.12, 1, 'active', 'new', '{"ports": ["HDMI", "USB-A x3", "USB-C", "SD", "microSD"]}'),
('CLTH-001', 'Classic T-Shirt', '100% cotton crew neck t-shirt', 19.99, 5.50, 0.20, 8, 'active', 'sale', '{"sizes": ["S", "M", "L", "XL"], "colors": ["white", "black", "navy"]}'),
('CLTH-002', 'Denim Jacket', 'Classic fit denim jacket', 79.99, 35.00, 0.75, 2, 'active', '', '{"material": "denim", "sizes": ["S", "M", "L", "XL"]}'),
('BOOK-001', 'The Rust Programming Language', 'Official Rust programming guide', 39.99, 15.00, 0.50, 3, 'active', 'featured', '{"isbn": "978-1718500440", "pages": 560, "format": "paperback"}'),
('BOOK-002', 'Database Internals', 'Deep dive into database system design', 54.99, 25.00, 0.65, 10, 'active', '', '{"isbn": "978-1492040347", "pages": 373, "format": "paperback"}'),
('HOME-001', 'LED Desk Lamp', 'Adjustable LED desk lamp with USB charging', 34.99, 14.00, 0.60, 4, 'active', 'new,sale', '{"watts": 12, "modes": 5, "dimmable": true}'),
('SPRT-001', 'Yoga Mat', 'Non-slip exercise yoga mat 6mm', 24.99, 8.00, 1.20, 5, 'active', '', '{"thickness": "6mm", "material": "TPE", "dimensions": "183x61cm"}'),
('DISC-001', 'Old Widget', 'Discontinued product for testing', 9.99, 3.00, 0.10, 1, 'discontinued', 'clearance', null);

-- Users
INSERT INTO users (username, email, password_hash, first_name, last_name, date_of_birth, role, settings, login_count) VALUES
('admin', 'admin@example.com', '$2b$12$placeholder_hash_admin_password', 'System', 'Administrator', '1990-01-15', 'admin', '{"theme": "dark", "language": "en", "notifications": true}', 150),
('jdoe', 'john.doe@example.com', '$2b$12$placeholder_hash_jdoe_password', 'John', 'Doe', '1985-06-20', 'manager', '{"theme": "light", "language": "en", "notifications": true}', 75),
('jsmith', 'jane.smith@example.com', '$2b$12$placeholder_hash_jsmith_password', 'Jane', 'Smith', '1992-03-10', 'user', '{"theme": "dark", "language": "en", "notifications": false}', 42),
('bob_dev', 'bob@example.com', '$2b$12$placeholder_hash_bob_password', 'Bob', 'Developer', '1988-11-30', 'user', '{"theme": "auto", "language": "en"}', 200),
('alice_qa', 'alice@example.com', '$2b$12$placeholder_hash_alice_password', 'Alice', 'Tester', '1995-07-25', 'viewer', null, 10);

-- Update last_login for some users
UPDATE users SET last_login = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE username = 'admin';
UPDATE users SET last_login = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE username = 'jdoe';
UPDATE users SET last_login = DATE_SUB(NOW(), INTERVAL 7 DAY) WHERE username = 'jsmith';

-- Orders
INSERT INTO orders (order_number, user_id, status, subtotal, tax, shipping, total, shipping_address, billing_address, ordered_at) VALUES
('ORD-20240101-0001', 2, 'delivered', 119.98, 9.60, 5.99, 135.57, '{"street": "123 Main St", "city": "Springfield", "state": "IL", "zip": "62701"}', '{"street": "123 Main St", "city": "Springfield", "state": "IL", "zip": "62701"}', '2024-01-15 10:30:00'),
('ORD-20240102-0002', 3, 'shipped', 89.99, 7.20, 0.00, 97.19, '{"street": "456 Oak Ave", "city": "Portland", "state": "OR", "zip": "97201"}', '{"street": "456 Oak Ave", "city": "Portland", "state": "OR", "zip": "97201"}', '2024-01-20 14:15:00'),
('ORD-20240103-0003', 2, 'pending', 54.99, 4.40, 3.99, 63.38, '{"street": "123 Main St", "city": "Springfield", "state": "IL", "zip": "62701"}', '{"street": "123 Main St", "city": "Springfield", "state": "IL", "zip": "62701"}', '2024-02-01 09:00:00'),
('ORD-20240104-0004', 4, 'processing', 144.97, 11.60, 0.00, 156.57, '{"street": "789 Pine Rd", "city": "Seattle", "state": "WA", "zip": "98101"}', '{"street": "789 Pine Rd", "city": "Seattle", "state": "WA", "zip": "98101"}', '2024-02-10 16:45:00'),
('ORD-20240105-0005', 3, 'cancelled', 19.99, 1.60, 5.99, 27.58, '{"street": "456 Oak Ave", "city": "Portland", "state": "OR", "zip": "97201"}', null, '2024-02-15 11:00:00');

-- Order Items
INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price) VALUES
(1, 1, 1, 29.99, 29.99),
(1, 2, 1, 89.99, 89.99),
(2, 2, 1, 89.99, 89.99),
(3, 7, 1, 54.99, 54.99),
(4, 2, 1, 89.99, 89.99),
(4, 3, 1, 49.99, 49.99),
(4, 9, 1, 24.99, 24.99),  -- Adding up: 89.99 + 49.99 + 24.99 = 164.97... close enough to match subtotal for seed data
(5, 4, 1, 19.99, 19.99);

-- Update order 4 subtotal to be accurate
UPDATE orders SET subtotal = 164.97, total = 164.97 + 13.20 WHERE id = 4;

-- Data types test rows
INSERT INTO data_types_test (
    col_tinyint, col_smallint, col_mediumint, col_int, col_bigint, col_unsigned_int,
    col_decimal, col_float, col_double,
    col_char, col_varchar, col_text,
    col_date, col_time, col_datetime, col_timestamp, col_year,
    col_enum, col_set, col_json, col_boolean, col_bit
) VALUES
(127, 32767, 8388607, 2147483647, 9223372036854775807, 4294967295,
 12345.6789, 3.14, 3.141592653589793,
 'ABCDEFGHIJ', 'Hello, World! 🌍', 'This is a text field with various content.',
 '2024-06-15', '14:30:00', '2024-06-15 14:30:00', CURRENT_TIMESTAMP, 2024,
 'a', 'x,y', '{"key": "value", "nested": {"array": [1, 2, 3]}}', TRUE, b'10101010'),
(-128, -32768, -8388608, -2147483648, -9223372036854775808, 0,
 -99999.9999, -0.001, 0.000000000000001,
 '', '', '',
 '1970-01-01', '00:00:00', '1970-01-01 00:00:00', '1970-01-01 00:00:01', 1901,
 'c', 'z', '[]', FALSE, b'00000000'),
(NULL, NULL, NULL, NULL, NULL, NULL,
 NULL, NULL, NULL,
 NULL, NULL, NULL,
 NULL, NULL, NULL, NULL, NULL,
 NULL, NULL, NULL, NULL, NULL);

-- Unicode test data
INSERT INTO unicode_test (content_utf8, content_emoji) VALUES
('Hello World', '👋🌍'),
('日本語テスト', '🇯🇵🎌'),
('Ñoño España', '🇪🇸🎉'),
('Ελληνικά', '🇬🇷🏛'),
('العربية', '🇸🇦📖'),
('中文测试数据', '🇨🇳🏮');

-- ============================================
-- ADDITIONAL DATABASE FOR EMPTY SCHEMA TESTING
-- ============================================

CREATE DATABASE IF NOT EXISTS test_db_empty;

-- ============================================
-- GRANT ADDITIONAL PERMISSIONS
-- ============================================

GRANT ALL PRIVILEGES ON test_db.* TO 'test_user'@'%';
GRANT ALL PRIVILEGES ON test_db_empty.* TO 'test_user'@'%';
GRANT PROCESS ON *.* TO 'test_user'@'%';
FLUSH PRIVILEGES;
