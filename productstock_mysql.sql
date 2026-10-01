-- MySQL 8.0+ schema for the productstock inventory database.
-- Importing this file drops and recreates the database named `productstock`.

DROP DATABASE IF EXISTS `productstock`;
CREATE DATABASE `productstock`
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE `productstock`;

/* 商品資料表 */
CREATE TABLE `products` (
    `product_id` INT AUTO_INCREMENT PRIMARY KEY COMMENT '蔬果編號',
    `product_code` VARCHAR(30) NOT NULL UNIQUE COMMENT '蔬菜代碼，例如西瓜01、哈密瓜02',
    `product_name` VARCHAR(100) NOT NULL COMMENT '蔬果名稱',
    `category` VARCHAR(50) COMMENT '類別，例如蔬菜或水果',
    `unit` VARCHAR(20) NOT NULL COMMENT '庫存單位',
    `box_weight_kg` DECIMAL(10,3) COMMENT '每箱淨重（公斤），模擬盤點換算規格',
    `box_weight_source` ENUM('PUBLIC_STANDARD', 'SIMULATION_ASSUMPTION') COMMENT '箱重依據',
    `box_weight_note` VARCHAR(255) COMMENT '公開規格來源或模擬假設備註',
    `shelf_life_days` INT COMMENT '保存天數',
    `min_stock` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '最低庫存數',
    `is_active` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '是否啟用',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '建立日期',
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改日期'
) ENGINE=InnoDB;

/* 同一商品可使用多種進貨單位；非公斤單位換算至庫存基準 kg。 */
CREATE TABLE `product_unit_conversions` (
    `product_id` INT NOT NULL,
    `unit_name` VARCHAR(20) NOT NULL,
    `kg_per_unit` DECIMAL(10,4) NOT NULL,
    `conversion_source` ENUM('PUBLIC_STANDARD', 'SIMULATION_ASSUMPTION') NOT NULL,
    `conversion_note` VARCHAR(255) NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`product_id`, `unit_name`),
    CONSTRAINT `fk_product_unit_conversions_product`
        FOREIGN KEY (`product_id`) REFERENCES `products` (`product_id`)
) ENGINE=InnoDB;

/* 供應商資料表 */
CREATE TABLE `suppliers` (
    `supplier_id` INT AUTO_INCREMENT PRIMARY KEY COMMENT '供應商編號',
    `supplier_code` VARCHAR(30) NOT NULL UNIQUE COMMENT '供應商代碼',
    `supplier_name` VARCHAR(100) NOT NULL COMMENT '供應商公司名稱',
    `contact_person` VARCHAR(50) COMMENT '聯絡人',
    `phone` VARCHAR(30) COMMENT '電話',
    `address` VARCHAR(255) COMMENT '公司地址',
    `is_active` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '是否啟用',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '建立日期'
) ENGINE=InnoDB;

/* 進貨單資料表 */
CREATE TABLE `purchase_orders` (
    `purchase_id` INT AUTO_INCREMENT PRIMARY KEY COMMENT '進貨編號',
    `purchase_no` VARCHAR(30) NOT NULL UNIQUE COMMENT '進貨單號',
    `supplier_id` INT NOT NULL,
    `purchase_date` DATE NOT NULL COMMENT '進貨日期',
    `total_amount` DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '進貨總金額',
    `remark` VARCHAR(255) COMMENT '備註',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '建立日期',
    INDEX `idx_purchase_orders_supplier` (`supplier_id`),
    CONSTRAINT `fk_purchase_orders_supplier`
        FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`supplier_id`)
) ENGINE=InnoDB;

/* 進貨明細資料表 */
CREATE TABLE `purchase_order_items` (
    `item_id` INT AUTO_INCREMENT PRIMARY KEY COMMENT '進貨明細編號',
    `purchase_id` INT NOT NULL,
    `product_id` INT NOT NULL,
    `quantity` DECIMAL(10,2) NOT NULL,
    `unit_cost` DECIMAL(10,2) NOT NULL,
    `input_quantity` DECIMAL(10,3) NULL COMMENT '原始進貨單位數量',
    `input_unit` VARCHAR(20) NULL COMMENT '原始進貨單位',
    `kg_per_unit` DECIMAL(10,4) NULL COMMENT '當次換算公斤倍率快照',
    `subtotal` DECIMAL(12,2) GENERATED ALWAYS AS (`quantity` * `unit_cost`) STORED COMMENT '明細金額',
    INDEX `idx_purchase_order_items_purchase` (`purchase_id`),
    INDEX `idx_purchase_order_items_product` (`product_id`),
    CONSTRAINT `fk_purchase_order_items_purchase`
        FOREIGN KEY (`purchase_id`) REFERENCES `purchase_orders` (`purchase_id`),
    CONSTRAINT `fk_purchase_order_items_product`
        FOREIGN KEY (`product_id`) REFERENCES `products` (`product_id`)
) ENGINE=InnoDB;

/* 庫存批次資料表 */
CREATE TABLE `inventory_batches` (
    `batch_id` INT AUTO_INCREMENT PRIMARY KEY COMMENT '庫存批次編號',
    `product_id` INT NOT NULL,
    `batch_no` VARCHAR(50) NOT NULL COMMENT '進貨批次編號',
    `received_date` DATE NOT NULL COMMENT '進貨日期',
    `expiry_date` DATE COMMENT '有效日期',
    `quantity` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '目前剩餘庫存',
    `unit_cost` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '單位成本',
    `supplier_id` INT,
    `status` ENUM('AVAILABLE', 'EXPIRED', 'DEPLETED') NOT NULL DEFAULT 'AVAILABLE',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uq_inventory_batches_product_batch` (`product_id`, `batch_no`),
    INDEX `idx_inventory_batches_supplier` (`supplier_id`),
    INDEX `idx_inventory_batches_stock` (`product_id`, `status`, `expiry_date`),
    CONSTRAINT `fk_inventory_batches_product`
        FOREIGN KEY (`product_id`) REFERENCES `products` (`product_id`),
    CONSTRAINT `fk_inventory_batches_supplier`
        FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`supplier_id`)
) ENGINE=InnoDB;

/* 庫存異動資料表；quantity 使用正數，方向由 transaction_type 判斷。 */
CREATE TABLE `inventory_transactions` (
    `transaction_id` BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '庫存異動編號',
    `product_id` INT NOT NULL,
    `batch_id` INT NOT NULL,
    `transaction_type` ENUM('PURCHASE', 'SALE', 'WASTE', 'RETURN', 'ADJUSTMENT') NOT NULL COMMENT '異動類型',
    `quantity` DECIMAL(10,2) NOT NULL COMMENT '異動數量，使用正數',
    `transaction_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `reference_id` INT COMMENT '關聯單據編號',
    `remark` VARCHAR(255),
    INDEX `idx_inventory_transactions_product` (`product_id`),
    INDEX `idx_inventory_transactions_batch_date` (`batch_id`, `transaction_date`),
    CONSTRAINT `fk_inventory_transactions_product`
        FOREIGN KEY (`product_id`) REFERENCES `products` (`product_id`),
    CONSTRAINT `fk_inventory_transactions_batch`
        FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches` (`batch_id`)
) ENGINE=InnoDB;

/* 倉庫及地圖格位 */
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

/* 一個格位最多放一個批次；同一批次可拆分放入多個格位。 */
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

/* 上架、移庫與下架的庫位異動紀錄 */
CREATE TABLE `location_transactions` (
    `location_transaction_id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `batch_id` INT NOT NULL,
    `from_location_id` INT,
    `to_location_id` INT,
    `quantity` DECIMAL(10,2) NOT NULL,
    `transaction_type` ENUM('PUTAWAY', 'MOVE', 'PICK', 'COUNT') NOT NULL,
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

/* 出貨單：待揀貨時先保留批次與格位數量，完成後才正式扣帳；取消可釋放保留量。 */
CREATE TABLE `outbound_orders` (
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

/* 出貨單預留的實際格位數量；完成時依這份分配更新倉儲地圖。 */
CREATE TABLE `outbound_order_allocations` (
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

/* 盤點單與逐格盤點結果 */
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
    `counted_box_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '本次實盤整箱數',
    `counted_loose_quantity_kg` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '本次實盤散裝公斤數',
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

/* FIFO 揀貨候選批次：先到期先出；未設定效期的批次排後，進貨日作為次排序。 */
SELECT *
FROM `inventory_batches`
WHERE `product_id` = 1
  AND `quantity` > 0
  AND `status` = 'AVAILABLE'
ORDER BY `expiry_date` IS NULL, `expiry_date` ASC, `received_date` ASC, `batch_id` ASC;

/* 各商品目前庫存 */
SELECT
    p.`product_id`,
    p.`product_name`,
    p.`unit`,
    COALESCE(SUM(b.`quantity`), 0) AS `total_stock`
FROM `products` AS p
LEFT JOIN `inventory_batches` AS b
    ON p.`product_id` = b.`product_id`
   AND b.`status` = 'AVAILABLE'
GROUP BY p.`product_id`, p.`product_name`, p.`unit`;

/* 低於最低庫存的商品 */
SELECT
    p.`product_name`,
    p.`min_stock`,
    COALESCE(SUM(b.`quantity`), 0) AS `current_stock`
FROM `products` AS p
LEFT JOIN `inventory_batches` AS b
    ON p.`product_id` = b.`product_id`
   AND b.`status` = 'AVAILABLE'
GROUP BY p.`product_id`, p.`product_name`, p.`min_stock`
HAVING `current_stock` < p.`min_stock`;

/* 七天內到期的蔬果 */
SELECT
    p.`product_name`,
    b.`batch_no`,
    b.`quantity`,
    b.`expiry_date`
FROM `inventory_batches` AS b
JOIN `products` AS p ON b.`product_id` = p.`product_id`
WHERE b.`quantity` > 0
  AND b.`status` = 'AVAILABLE'
  AND b.`expiry_date` BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
ORDER BY b.`expiry_date` ASC;
