-- Add cycle-count support to an existing productstock database.
-- This migration only creates count tables and extends the location transaction enum.
-- Run warehouse_migration.sql first if warehouse-map tables have not been installed.
USE `productstock`;

CREATE TABLE `inventory_count_sessions` (
    `count_session_id` INT AUTO_INCREMENT PRIMARY KEY,
    `warehouse_id` INT NOT NULL,
    `zone_code` VARCHAR(30) NOT NULL,
    `status` ENUM('COUNTING', 'REVIEW', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'COUNTING',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `completed_at` DATETIME,
    INDEX `idx_count_sessions_scope_status` (`warehouse_id`, `zone_code`, `status`),
    CONSTRAINT `fk_count_sessions_warehouse`
        FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses` (`warehouse_id`)
) ENGINE=InnoDB;

CREATE TABLE `inventory_count_lines` (
    `count_line_id` INT AUTO_INCREMENT PRIMARY KEY,
    `count_session_id` INT NOT NULL,
    `location_id` INT NOT NULL,
    `expected_batch_id` INT,
    `expected_quantity` DECIMAL(10,2) NOT NULL DEFAULT 0,
    `counted_batch_id` INT,
    `counted_quantity` DECIMAL(10,2),
    `line_status` ENUM('PENDING', 'COUNTED') NOT NULL DEFAULT 'PENDING',
    `variance_reason` VARCHAR(255),
    `counted_at` DATETIME,
    UNIQUE KEY `uq_count_line_session_location` (`count_session_id`, `location_id`),
    INDEX `idx_count_lines_batch` (`expected_batch_id`, `counted_batch_id`),
    CONSTRAINT `fk_count_lines_session`
        FOREIGN KEY (`count_session_id`) REFERENCES `inventory_count_sessions` (`count_session_id`),
    CONSTRAINT `fk_count_lines_location`
        FOREIGN KEY (`location_id`) REFERENCES `warehouse_locations` (`location_id`),
    CONSTRAINT `fk_count_lines_expected_batch`
        FOREIGN KEY (`expected_batch_id`) REFERENCES `inventory_batches` (`batch_id`),
    CONSTRAINT `fk_count_lines_counted_batch`
        FOREIGN KEY (`counted_batch_id`) REFERENCES `inventory_batches` (`batch_id`)
) ENGINE=InnoDB;

ALTER TABLE `location_transactions`
    MODIFY `transaction_type` ENUM('PUTAWAY', 'MOVE', 'PICK', 'COUNT') NOT NULL;
