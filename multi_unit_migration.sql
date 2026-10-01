-- 同商品多單位進貨升級；先確保 warehouse_migration.sql 與 count_migration.sql 已完成。
-- 本升級採新增欄位方式，不刪除或重算任何既有庫存；可重複執行。
USE `productstock`;

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'box_weight_kg');
SET @ddl = IF(@has_column = 0, 'ALTER TABLE `products` ADD COLUMN `box_weight_kg` DECIMAL(10,3) NULL COMMENT ''每箱淨重（公斤）''', 'SELECT 1');
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'box_weight_source');
SET @ddl = IF(@has_column = 0, 'ALTER TABLE `products` ADD COLUMN `box_weight_source` ENUM(''PUBLIC_STANDARD'', ''SIMULATION_ASSUMPTION'') NULL COMMENT ''箱重依據''', 'SELECT 1');
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'box_weight_note');
SET @ddl = IF(@has_column = 0, 'ALTER TABLE `products` ADD COLUMN `box_weight_note` VARCHAR(255) NULL COMMENT ''箱重依據說明''', 'SELECT 1');
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS `product_unit_conversions` (
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

INSERT IGNORE INTO `product_unit_conversions`
    (`product_id`, `unit_name`, `kg_per_unit`, `conversion_source`, `conversion_note`)
SELECT `product_id`, '箱', `box_weight_kg`,
       COALESCE(`box_weight_source`, 'SIMULATION_ASSUMPTION'),
       COALESCE(`box_weight_note`, '沿用原商品設定的每箱重量')
FROM `products`
WHERE `box_weight_kg` IS NOT NULL AND `box_weight_kg` > 0;

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_items' AND COLUMN_NAME = 'input_quantity');
SET @ddl = IF(@has_column = 0, 'ALTER TABLE `purchase_order_items` ADD COLUMN `input_quantity` DECIMAL(10,3) NULL COMMENT ''原始進貨單位數量''', 'SELECT 1');
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_items' AND COLUMN_NAME = 'input_unit');
SET @ddl = IF(@has_column = 0, 'ALTER TABLE `purchase_order_items` ADD COLUMN `input_unit` VARCHAR(20) NULL COMMENT ''原始進貨單位''', 'SELECT 1');
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_items' AND COLUMN_NAME = 'kg_per_unit');
SET @ddl = IF(@has_column = 0, 'ALTER TABLE `purchase_order_items` ADD COLUMN `kg_per_unit` DECIMAL(10,4) NULL COMMENT ''當次公斤換算倍率快照''', 'SELECT 1');
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_count_lines' AND COLUMN_NAME = 'counted_box_count');
SET @ddl = IF(@has_column = 0, 'ALTER TABLE `inventory_count_lines` ADD COLUMN `counted_box_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''實盤整箱數''', 'SELECT 1');
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_count_lines' AND COLUMN_NAME = 'counted_loose_quantity_kg');
SET @ddl = IF(@has_column = 0, 'ALTER TABLE `inventory_count_lines` ADD COLUMN `counted_loose_quantity_kg` DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT ''實盤散裝公斤數''', 'SELECT 1');
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
