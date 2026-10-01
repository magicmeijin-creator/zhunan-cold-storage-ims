-- Track when inventory was registered and when a batch was placed into a bin.
-- Run warehouse_migration.sql first if warehouse-map tables do not exist yet.
USE `productstock`;

-- Legacy occupied bins stay NULL (shown as "存入時間未記錄"); new placements
-- receive the current timestamp automatically.
ALTER TABLE `batch_locations`
    ADD COLUMN `stored_at` DATETIME NULL COMMENT '此批次存入此格位的時間';

ALTER TABLE `batch_locations`
    MODIFY COLUMN `stored_at` DATETIME NULL DEFAULT CURRENT_TIMESTAMP
        COMMENT '此批次存入此格位的時間';
