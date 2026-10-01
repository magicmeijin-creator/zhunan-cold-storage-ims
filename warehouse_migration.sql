-- Add warehouse-map support to an existing productstock database.
-- This migration does not drop, replace, or rewrite existing inventory tables/data.
USE `productstock`;

CREATE TABLE `warehouses` (
    `warehouse_id` INT AUTO_INCREMENT PRIMARY KEY,
    `warehouse_name` VARCHAR(100) NOT NULL UNIQUE,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE `warehouse_locations` (
    `location_id` INT AUTO_INCREMENT PRIMARY KEY,
    `warehouse_id` INT NOT NULL,
    `zone_code` VARCHAR(30) NOT NULL DEFAULT 'A',
    `row_no` SMALLINT UNSIGNED NOT NULL,
    `column_no` SMALLINT UNSIGNED NOT NULL,
    `location_code` VARCHAR(50) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE KEY `uq_location_code` (`warehouse_id`, `location_code`),
    UNIQUE KEY `uq_location_grid_position` (`warehouse_id`, `zone_code`, `row_no`, `column_no`),
    CONSTRAINT `fk_warehouse_locations_warehouse`
        FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses` (`warehouse_id`)
) ENGINE=InnoDB;

CREATE TABLE `batch_locations` (
    `location_id` INT PRIMARY KEY,
    `batch_id` INT NOT NULL,
    `quantity` DECIMAL(10,2) NOT NULL,
    `stored_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '此批次存入此格位的時間',
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_batch_locations_batch` (`batch_id`),
    CONSTRAINT `fk_batch_locations_location`
        FOREIGN KEY (`location_id`) REFERENCES `warehouse_locations` (`location_id`),
    CONSTRAINT `fk_batch_locations_batch`
        FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches` (`batch_id`)
) ENGINE=InnoDB;

CREATE TABLE `location_transactions` (
    `location_transaction_id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `batch_id` INT NOT NULL,
    `from_location_id` INT,
    `to_location_id` INT,
    `quantity` DECIMAL(10,2) NOT NULL,
    `transaction_type` ENUM('PUTAWAY', 'MOVE', 'PICK') NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `remark` VARCHAR(255),
    INDEX `idx_location_transactions_batch` (`batch_id`, `created_at`),
    CONSTRAINT `fk_location_transactions_batch`
        FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches` (`batch_id`),
    CONSTRAINT `fk_location_transactions_from`
        FOREIGN KEY (`from_location_id`) REFERENCES `warehouse_locations` (`location_id`),
    CONSTRAINT `fk_location_transactions_to`
        FOREIGN KEY (`to_location_id`) REFERENCES `warehouse_locations` (`location_id`)
) ENGINE=InnoDB;
