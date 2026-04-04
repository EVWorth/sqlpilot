-- Large dataset for performance testing
USE test_db;

CREATE TABLE IF NOT EXISTS large_table (
    id INT AUTO_INCREMENT PRIMARY KEY,
    uuid CHAR(36) NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    amount DECIMAL(10,2),
    status ENUM('active', 'inactive', 'pending') NOT NULL,
    description TEXT,
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_uuid (uuid),
    INDEX idx_email (email),
    INDEX idx_status (status),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Generate 100K rows using a stored procedure
DELIMITER //
CREATE PROCEDURE generate_large_data()
BEGIN
    DECLARE i INT DEFAULT 0;
    WHILE i < 100000 DO
        INSERT INTO large_table (uuid, name, email, amount, status, description, metadata)
        VALUES (
            UUID(),
            CONCAT('User_', LPAD(i, 6, '0')),
            CONCAT('user', i, '@example.com'),
            ROUND(RAND() * 10000, 2),
            ELT(FLOOR(RAND() * 3) + 1, 'active', 'inactive', 'pending'),
            CONCAT('Description for record ', i, '. This is test data for performance testing.'),
            JSON_OBJECT('index', i, 'batch', FLOOR(i / 1000), 'random', ROUND(RAND(), 4))
        );
        SET i = i + 1;
        -- Commit every 10000 rows for performance
        IF i MOD 10000 = 0 THEN
            COMMIT;
        END IF;
    END WHILE;
END //
DELIMITER ;

CALL generate_large_data();
DROP PROCEDURE IF EXISTS generate_large_data;
