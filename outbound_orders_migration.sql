-- Add shipment orders and reserved pick locations to an existing productstock database.
USE `productstock`;

CREATE TABLE IF NOT EXISTS `outbound_orders` (
    `outbound_order_id` INT AUTO_INCREMENT PRIMARY KEY,
    `outbound_no` VARCHAR(30) NOT NULL UNIQUE,
    `product_id` INT NOT NULL,
    `batch_id` INT NOT NULL,
    `quantity` DECIMAL(10,2) NOT NULL,
    `status` ENUM('WAITING_PICK', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'WAITING_PICK',
    `remark` VARCHAR(255),
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `completed_at` DATETIME,
    `cancelled_at` DATETIME,
    INDEX `idx_outbound_orders_batch_status` (`batch_id`, `status`),
    INDEX `idx_outbound_orders_status_created` (`status`, `created_at`),
    CONSTRAINT `fk_outbound_orders_product`
        FOREIGN KEY (`product_id`) REFERENCES `products` (`product_id`),
    CONSTRAINT `fk_outbound_orders_batch`
        FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches` (`batch_id`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `outbound_order_allocations` (
    `allocation_id` INT AUTO_INCREMENT PRIMARY KEY,
    `outbound_order_id` INT NOT NULL,
    `location_id` INT NOT NULL,
    `quantity` DECIMAL(10,2) NOT NULL,
    INDEX `idx_outbound_allocations_location` (`location_id`),
    CONSTRAINT `fk_outbound_allocations_order`
        FOREIGN KEY (`outbound_order_id`) REFERENCES `outbound_orders` (`outbound_order_id`),
    CONSTRAINT `fk_outbound_allocations_location`
        FOREIGN KEY (`location_id`) REFERENCES `warehouse_locations` (`location_id`)
) ENGINE=InnoDB;
