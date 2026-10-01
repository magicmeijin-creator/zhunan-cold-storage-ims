require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "productstock",
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  dateStrings: true,
});

app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname));

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

async function assertZoneNotCountLocked(connection, warehouseId, zoneCode) {
  const [rows] = await connection.execute(
    `SELECT count_session_id FROM inventory_count_sessions
     WHERE warehouse_id = ? AND zone_code = ? AND status IN ('COUNTING', 'REVIEW')
     LIMIT 1 FOR UPDATE`,
    [warehouseId, zoneCode],
  );
  if (rows.length) {
    throw conflict(`區域 ${zoneCode} 正在盤點，暫時不能移動或扣減該區庫存。`);
  }
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: process.env.DB_NAME || "productstock" });
  } catch (error) {
    res
      .status(503)
      .json({ ok: false, message: "無法連線到 MySQL，請檢查資料庫設定。" });
  }
});

app.get("/api/inventory", async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT b.batch_id AS id, b.batch_no, p.product_id, p.product_code,
             p.product_name AS name, p.category, p.unit, s.supplier_name AS origin,
             b.received_date AS inboundDate, b.created_at AS receivedAt,
             b.expiry_date AS expiryDate,
             b.quantity AS qty, b.unit_cost AS unitCostPerKg, b.status,
             poi.input_quantity, poi.input_unit,
             poi.kg_per_unit
      FROM inventory_batches b
      JOIN products p ON p.product_id = b.product_id
      LEFT JOIN suppliers s ON s.supplier_id = b.supplier_id
      LEFT JOIN inventory_transactions pt ON pt.batch_id = b.batch_id AND pt.transaction_type = 'PURCHASE'
      LEFT JOIN purchase_order_items poi ON poi.purchase_id = pt.reference_id AND poi.product_id = b.product_id
      WHERE b.quantity > 0 AND b.status = 'AVAILABLE'
      ORDER BY b.expiry_date IS NULL, b.expiry_date, b.received_date, b.batch_id
    `);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get("/api/batches/:id/locations", async (req, res, next) => {
  const batchId = Number(req.params.id);
  if (!Number.isInteger(batchId) || batchId < 1)
    return next(badRequest("批次編號不正確。"));
  try {
    const [rows] = await pool.execute(
      `SELECT w.warehouse_name, l.zone_code, l.location_code, bl.quantity
       FROM batch_locations bl
       JOIN warehouse_locations l ON l.location_id = bl.location_id AND l.is_active = TRUE
       JOIN warehouses w ON w.warehouse_id = l.warehouse_id
       WHERE bl.batch_id = ?
       ORDER BY w.warehouse_name, l.zone_code, l.row_no, l.column_no`,
      [batchId],
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get("/api/products/unit-conversion", async (req, res, next) => {
  const name = String(req.query.name || "").trim();
  const unit = String(req.query.unit || "").trim();
  if (!name || !unit) return res.json({ productFound: false, kgPerUnit: unit === "kg" ? 1 : null });
  try {
    const [rows] = await pool.execute(
      `SELECT p.unit AS baseUnit, c.kg_per_unit AS kgPerUnit,
              c.conversion_source AS source, c.conversion_note AS note
       FROM products p LEFT JOIN product_unit_conversions c
         ON c.product_id = p.product_id AND c.unit_name = ?
       WHERE p.product_name = ? LIMIT 1`,
      [unit, name],
    );
    if (!rows.length) return res.json({ productFound: false, kgPerUnit: unit === "kg" ? 1 : null });
    res.json({ productFound: true, ...rows[0], kgPerUnit: rows[0].kgPerUnit == null ? (unit === "kg" ? 1 : null) : Number(rows[0].kgPerUnit) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/receipts", async (req, res, next) => {
  const {
    name,
    category,
    origin,
    inboundDate,
    expiryDate,
    inputQuantity,
    inputUnit,
    kgPerUnit,
    conversionSource,
    conversionNote,
    unitCostPerKg = 0,
  } = req.body;
  const enteredQuantity = Number(inputQuantity);
  const conversion = Number(kgPerUnit);
  const quantity = Math.round((enteredQuantity * conversion + Number.EPSILON) * 100) / 100;
  const cost = Number(unitCostPerKg);
  if (
    !name?.trim() ||
    !category?.trim() ||
    !inboundDate ||
    !inputUnit?.trim() ||
    !Number.isFinite(enteredQuantity) || enteredQuantity <= 0 ||
    !Number.isFinite(conversion) || conversion <= 0 || quantity <= 0 ||
    !["PUBLIC_STANDARD", "SIMULATION_ASSUMPTION"].includes(conversionSource) ||
    !conversionNote?.trim() ||
    !Number.isFinite(cost) ||
    cost < 0
  ) {
    return next(badRequest("請填寫有效的商品、日期、進貨數量、單位換算與每公斤成本。"));
  }
  if (inputUnit.trim() === "kg" && conversion !== 1)
    return next(badRequest("公斤換算倍率固定為 1。"));
  if (expiryDate && expiryDate < inboundDate)
    return next(badRequest("到期日不可早於進貨日。"));

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [products] = await connection.execute(
      "SELECT product_id, unit FROM products WHERE product_name = ? LIMIT 1 FOR UPDATE",
      [name.trim()],
    );
    let productId;
    if (products.length) {
      if (products[0].unit !== "kg")
        throw badRequest(`此商品目前使用「${products[0].unit}」且已有歷史庫存。為避免誤換算，請先確認並轉換舊庫存後再啟用公斤基準。`);
      productId = products[0].product_id;
    } else {
      const productCode =
        `P${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 30);
      const [result] = await connection.execute(
        "INSERT INTO products (product_code, product_name, category, unit) VALUES (?, ?, ?, 'kg')",
        [productCode, name.trim(), category.trim()],
      );
      productId = result.insertId;
    }

    if (inputUnit.trim() !== "kg") {
      const [conversions] = await connection.execute(
        "SELECT kg_per_unit FROM product_unit_conversions WHERE product_id = ? AND unit_name = ? FOR UPDATE",
        [productId, inputUnit.trim()],
      );
      if (conversions.length && Math.abs(Number(conversions[0].kg_per_unit) - conversion) > 0.00005)
        throw badRequest(`「${name.trim()}」的「${inputUnit.trim()}」已設定為每單位 ${conversions[0].kg_per_unit} kg，請沿用該換算值。`);
      if (!conversions.length) {
        await connection.execute(
          `INSERT INTO product_unit_conversions
           (product_id, unit_name, kg_per_unit, conversion_source, conversion_note)
           VALUES (?, ?, ?, ?, ?)`,
          [productId, inputUnit.trim(), conversion, conversionSource, conversionNote.trim()],
        );
      }
    }

    const supplierName = origin?.trim() || "未指定供應商";
    const [suppliers] = await connection.execute(
      "SELECT supplier_id FROM suppliers WHERE supplier_name = ? LIMIT 1 FOR UPDATE",
      [supplierName],
    );
    let supplierId;
    if (suppliers.length) supplierId = suppliers[0].supplier_id;
    else {
      const supplierCode =
        `S${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 30);
      const [result] = await connection.execute(
        "INSERT INTO suppliers (supplier_code, supplier_name) VALUES (?, ?)",
        [supplierCode, supplierName],
      );
      supplierId = result.insertId;
    }

    const purchaseNo = `PO${Date.now()}`.slice(0, 30);
    const [order] = await connection.execute(
      "INSERT INTO purchase_orders (purchase_no, supplier_id, purchase_date, total_amount) VALUES (?, ?, ?, ?)",
      [purchaseNo, supplierId, inboundDate, quantity * cost],
    );
    await connection.execute(
      "INSERT INTO purchase_order_items (purchase_id, product_id, quantity, unit_cost, input_quantity, input_unit, kg_per_unit) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [order.insertId, productId, quantity, cost, enteredQuantity, inputUnit.trim(), conversion],
    );

    const batchNo = `B${Date.now()}`.slice(0, 50);
    const [batch] = await connection.execute(
      `INSERT INTO inventory_batches
       (product_id, batch_no, received_date, expiry_date, quantity, unit_cost, supplier_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        productId,
        batchNo,
        inboundDate,
        expiryDate || null,
        quantity,
        cost,
        supplierId,
      ],
    );
    await connection.execute(
      `INSERT INTO inventory_transactions
       (product_id, batch_id, transaction_type, quantity, reference_id, remark)
       VALUES (?, ?, 'PURCHASE', ?, ?, ?)`,
      [
        productId,
        batch.insertId,
        quantity,
        order.insertId,
        `進貨單 ${purchaseNo}`,
      ],
    );
    await connection.commit();
    res.status(201).json({ ok: true, batchId: batch.insertId, purchaseNo });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.post("/api/batches/:id/issues", async (req, res, next) => {
  const batchId = Number(req.params.id);
  const quantity = Number(req.body.quantity);
  const type = req.body.type;
  const transactionType =
    type === "scrap" ? "WASTE" : type === "deduct" ? "SALE" : null;
  if (
    !Number.isInteger(batchId) ||
    batchId < 1 ||
    !transactionType ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return next(badRequest("出庫資料不正確，請確認數量與操作類型。"));
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT product_id, quantity FROM inventory_batches WHERE batch_id = ? AND status = 'AVAILABLE' FOR UPDATE",
      [batchId],
    );
    if (!rows.length) throw badRequest("找不到可用的庫存批次。");
    const remaining = Number(rows[0].quantity) - quantity;
    if (remaining < -0.000001) throw badRequest("扣減數量不能大於現有庫存。");
    const [placements] = await connection.execute(
      `SELECT bl.location_id, bl.quantity, l.warehouse_id, l.zone_code
       FROM batch_locations bl JOIN warehouse_locations l ON l.location_id = bl.location_id
       WHERE bl.batch_id = ? ORDER BY bl.location_id FOR UPDATE`,
      [batchId],
    );
    const placedTotal = placements.reduce(
      (sum, placement) => sum + Number(placement.quantity),
      0,
    );
    let pickFromLocations = Math.max(
      0,
      quantity - Math.max(0, Number(rows[0].quantity) - placedTotal),
    );
    if (pickFromLocations > placedTotal + 0.000001)
      throw new Error("批次庫存與格位配置數量不一致，請先核對庫存。");
    for (const placement of placements) {
      if (pickFromLocations <= 0.000001) break;
      const picked = Math.min(Number(placement.quantity), pickFromLocations);
      await assertZoneNotCountLocked(
        connection,
        placement.warehouse_id,
        placement.zone_code,
      );
      const slotRemaining = Number(placement.quantity) - picked;
      if (slotRemaining <= 0.000001) {
        await connection.execute(
          "DELETE FROM batch_locations WHERE location_id = ?",
          [placement.location_id],
        );
      } else {
        await connection.execute(
          "UPDATE batch_locations SET quantity = ? WHERE location_id = ?",
          [slotRemaining, placement.location_id],
        );
      }
      await connection.execute(
        `INSERT INTO location_transactions (batch_id, from_location_id, quantity, transaction_type, remark)
         VALUES (?, ?, ?, 'PICK', ?)`,
        [
          batchId,
          placement.location_id,
          picked,
          type === "scrap" ? "報廢下架" : "出庫揀貨",
        ],
      );
      pickFromLocations -= picked;
    }
    await connection.execute(
      `UPDATE inventory_batches SET quantity = ?, status = ? WHERE batch_id = ?`,
      [
        Math.max(0, remaining),
        remaining <= 0 ? "DEPLETED" : "AVAILABLE",
        batchId,
      ],
    );
    await connection.execute(
      `INSERT INTO inventory_transactions
       (product_id, batch_id, transaction_type, quantity, remark)
       VALUES (?, ?, ?, ?, ?)`,
      [
        rows[0].product_id,
        batchId,
        transactionType,
        quantity,
        String(req.body.remark || "").slice(0, 255),
      ],
    );
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.get("/api/warehouses", async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(
      "SELECT warehouse_id, warehouse_name FROM warehouses ORDER BY warehouse_name",
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/warehouses/:id", async (req, res, next) => {
  const warehouseId = Number(req.params.id);
  const name = String(req.body.name || "").trim();
  if (!Number.isInteger(warehouseId) || warehouseId < 1) {
    return next(badRequest("倉庫編號不正確。"));
  }
  if (!name || name.length > 100) {
    return next(badRequest("倉庫名稱不可空白，且最多 100 個字元。"));
  }
  try {
    const [result] = await pool.execute(
      "UPDATE warehouses SET warehouse_name = ? WHERE warehouse_id = ?",
      [name, warehouseId],
    );
    if (result.affectedRows === 0) {
      const [rows] = await pool.execute(
        "SELECT warehouse_id FROM warehouses WHERE warehouse_id = ?",
        [warehouseId],
      );
      if (!rows.length) return next(badRequest("找不到這個倉庫。"));
    }
    res.json({ ok: true, warehouseId, name });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return next(badRequest("已經有同名的倉庫，請改用其他名稱。"));
    }
    next(error);
  }
});

app.post("/api/warehouses", async (req, res, next) => {
  const name = String(req.body.name || "").trim();
  const zoneCode = String(req.body.zoneCode || "A")
    .trim()
    .toUpperCase();
  const rowCount = Number(req.body.rows);
  const columnCount = Number(req.body.columns);
  if (
    !name ||
    !/^[A-Z0-9_-]{1,30}$/.test(zoneCode) ||
    !Number.isInteger(rowCount) ||
    !Number.isInteger(columnCount) ||
    rowCount < 1 ||
    rowCount > 40 ||
    columnCount < 1 ||
    columnCount > 40 ||
    rowCount * columnCount > 400
  ) {
    return next(
      badRequest(
        "請輸入倉庫名稱、區域代碼與有效的格位列數／欄數（最多 400 格）。",
      ),
    );
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [warehouse] = await connection.execute(
      "INSERT INTO warehouses (warehouse_name) VALUES (?)",
      [name],
    );
    const values = [];
    for (let row = 1; row <= rowCount; row += 1) {
      for (let column = 1; column <= columnCount; column += 1) {
        const code = `${zoneCode}-${String(row).padStart(2, "0")}-${String(column).padStart(2, "0")}`;
        values.push([warehouse.insertId, zoneCode, row, column, code]);
      }
    }
    await connection.query(
      "INSERT INTO warehouse_locations (warehouse_id, zone_code, row_no, column_no, location_code) VALUES ?",
      [values],
    );
    await connection.commit();
    res
      .status(201)
      .json({
        warehouseId: warehouse.insertId,
        name,
        zoneCode,
        rows: rowCount,
        columns: columnCount,
      });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.post("/api/warehouses/:id/zones", async (req, res, next) => {
  const warehouseId = Number(req.params.id);
  const zoneCode = String(req.body.zoneCode || "")
    .trim()
    .toUpperCase();
  const rowCount = Number(req.body.rows);
  const columnCount = Number(req.body.columns);
  if (
    !Number.isInteger(warehouseId) ||
    warehouseId < 1 ||
    !/^[A-Z0-9_-]{1,30}$/.test(zoneCode) ||
    !Number.isInteger(rowCount) ||
    !Number.isInteger(columnCount) ||
    rowCount < 1 ||
    rowCount > 40 ||
    columnCount < 1 ||
    columnCount > 40 ||
    rowCount * columnCount > 400
  ) {
    return next(
      badRequest("請輸入有效的區域代碼與格位列數／欄數（最多 400 格）。"),
    );
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [warehouses] = await connection.execute(
      "SELECT warehouse_id FROM warehouses WHERE warehouse_id = ? FOR UPDATE",
      [warehouseId],
    );
    if (!warehouses.length) throw badRequest("找不到這個倉庫。");
    await assertZoneNotCountLocked(connection, warehouseId, zoneCode);
    const values = [];
    for (let row = 1; row <= rowCount; row += 1) {
      for (let column = 1; column <= columnCount; column += 1) {
        const code = `${zoneCode}-${String(row).padStart(2, "0")}-${String(column).padStart(2, "0")}`;
        values.push([warehouseId, zoneCode, row, column, code]);
      }
    }
    await connection.query(
      "INSERT INTO warehouse_locations (warehouse_id, zone_code, row_no, column_no, location_code) VALUES ?",
      [values],
    );
    await connection.commit();
    res
      .status(201)
      .json({ ok: true, zoneCode, rows: rowCount, columns: columnCount });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.get("/api/warehouses/:id/map", async (req, res, next) => {
  const warehouseId = Number(req.params.id);
  if (!Number.isInteger(warehouseId) || warehouseId < 1)
    return next(badRequest("倉庫編號不正確。"));
  try {
    const [locations] = await pool.execute(
      `
      SELECT l.location_id, l.zone_code, l.row_no, l.column_no, l.location_code,
             bl.batch_id, bl.quantity AS stored_quantity, bl.stored_at AS storedAt,
             p.product_id, p.product_name, p.product_code,
             p.unit, b.batch_no, b.expiry_date
      FROM warehouse_locations l
      LEFT JOIN batch_locations bl ON bl.location_id = l.location_id
      LEFT JOIN inventory_batches b ON b.batch_id = bl.batch_id
      LEFT JOIN products p ON p.product_id = b.product_id
      WHERE l.warehouse_id = ? AND l.is_active = TRUE
      ORDER BY l.zone_code, l.row_no, l.column_no`,
      [warehouseId],
    );
    res.json(locations);
  } catch (error) {
    next(error);
  }
});

app.get("/api/warehouses/:id/unlocated-batches", async (req, res, next) => {
  const warehouseId = Number(req.params.id);
  if (!Number.isInteger(warehouseId) || warehouseId < 1)
    return next(badRequest("倉庫編號不正確。"));
  try {
    const [rows] = await pool.execute(`
      SELECT b.batch_id, b.batch_no, b.quantity - COALESCE(SUM(bl.quantity), 0) AS unlocated_quantity,
             b.expiry_date, p.product_name, p.unit
      FROM inventory_batches b
      JOIN products p ON p.product_id = b.product_id
      LEFT JOIN batch_locations bl ON bl.batch_id = b.batch_id
      WHERE b.quantity > 0 AND b.status = 'AVAILABLE'
      GROUP BY b.batch_id, b.batch_no, b.quantity, b.expiry_date, p.product_name, p.unit
      HAVING unlocated_quantity > 0
      ORDER BY b.expiry_date IS NULL, b.expiry_date, b.batch_id`);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post("/api/locations/:id/putaway", async (req, res, next) => {
  const locationId = Number(req.params.id);
  const batchId = Number(req.body.batchId);
  const quantity = Number(req.body.quantity);
  if (
    !Number.isInteger(locationId) ||
    locationId < 1 ||
    !Number.isInteger(batchId) ||
    batchId < 1 ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return next(badRequest("請選擇有效的格位、批次與上架數量。"));
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [slots] = await connection.execute(
      "SELECT location_id, warehouse_id, zone_code FROM warehouse_locations WHERE location_id = ? AND is_active = TRUE FOR UPDATE",
      [locationId],
    );
    if (!slots.length) throw badRequest("找不到這個啟用中的格位。");
    await assertZoneNotCountLocked(
      connection,
      slots[0].warehouse_id,
      slots[0].zone_code,
    );
    const [occupants] = await connection.execute(
      "SELECT batch_id FROM batch_locations WHERE location_id = ? FOR UPDATE",
      [locationId],
    );
    if (occupants.length)
      throw badRequest("這個格位已經有庫存，請先選擇空格位。");
    const [batches] = await connection.execute(
      `SELECT b.product_id, b.quantity - COALESCE((SELECT SUM(bl.quantity) FROM batch_locations bl WHERE bl.batch_id = b.batch_id), 0) AS unlocated
       FROM inventory_batches b WHERE b.batch_id = ? AND b.status = 'AVAILABLE' AND b.quantity > 0 FOR UPDATE`,
      [batchId],
    );
    if (!batches.length || quantity > Number(batches[0].unlocated) + 0.000001)
      throw badRequest("上架數量超過此批次尚未上架的庫存。");
    await connection.execute(
      "INSERT INTO batch_locations (location_id, batch_id, quantity) VALUES (?, ?, ?)",
      [locationId, batchId, quantity],
    );
    await connection.execute(
      `INSERT INTO location_transactions (batch_id, to_location_id, quantity, transaction_type, remark)
       VALUES (?, ?, ?, 'PUTAWAY', '上架')`,
      [batchId, locationId, quantity],
    );
    await connection.commit();
    res.status(201).json({ ok: true });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.post("/api/locations/:id/move", async (req, res, next) => {
  const sourceId = Number(req.params.id);
  const destinationId = Number(req.body.destinationLocationId);
  const quantity = Number(req.body.quantity);
  if (
    !Number.isInteger(sourceId) ||
    !Number.isInteger(destinationId) ||
    sourceId < 1 ||
    destinationId < 1 ||
    sourceId === destinationId ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return next(badRequest("請選擇不同的來源／目的格位與有效數量。"));
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [slots] = await connection.execute(
      "SELECT location_id, warehouse_id, zone_code FROM warehouse_locations WHERE location_id IN (?, ?) AND is_active = TRUE ORDER BY location_id FOR UPDATE",
      [sourceId, destinationId],
    );
    if (slots.length !== 2) throw badRequest("來源或目的格位不存在。");
    for (const slot of slots) {
      await assertZoneNotCountLocked(
        connection,
        slot.warehouse_id,
        slot.zone_code,
      );
    }
    const [sourceRows] = await connection.execute(
      "SELECT batch_id, quantity FROM batch_locations WHERE location_id = ? FOR UPDATE",
      [sourceId],
    );
    if (
      !sourceRows.length ||
      quantity > Number(sourceRows[0].quantity) + 0.000001
    )
      throw badRequest("移庫數量超過來源格位庫存。");
    const batchId = sourceRows[0].batch_id;
    const [destinationRows] = await connection.execute(
      "SELECT batch_id, quantity FROM batch_locations WHERE location_id = ? FOR UPDATE",
      [destinationId],
    );
    if (
      destinationRows.length &&
      Number(destinationRows[0].batch_id) !== Number(batchId)
    )
      throw badRequest("目的格位已有其他批次，不能混放。");

    const remaining = Number(sourceRows[0].quantity) - quantity;
    if (remaining <= 0.000001)
      await connection.execute(
        "DELETE FROM batch_locations WHERE location_id = ?",
        [sourceId],
      );
    else
      await connection.execute(
        "UPDATE batch_locations SET quantity = ? WHERE location_id = ?",
        [remaining, sourceId],
      );
    if (destinationRows.length) {
      await connection.execute(
        "UPDATE batch_locations SET quantity = quantity + ?, stored_at = CURRENT_TIMESTAMP WHERE location_id = ?",
        [quantity, destinationId],
      );
    } else {
      await connection.execute(
        "INSERT INTO batch_locations (location_id, batch_id, quantity) VALUES (?, ?, ?)",
        [destinationId, batchId, quantity],
      );
    }
    await connection.execute(
      `INSERT INTO location_transactions (batch_id, from_location_id, to_location_id, quantity, transaction_type, remark)
       VALUES (?, ?, ?, ?, 'MOVE', '庫位移動')`,
      [batchId, sourceId, destinationId, quantity],
    );
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.get("/api/records", async (req, res, next) => {
  const { from, to, type, keyword, warehouseId, zoneCode } = req.query;
  const allowedTypes = new Set(["PURCHASE", "SALE", "WASTE", "RETURN", "ADJUSTMENT", "MOVE", "PUTAWAY", "PICK"]);
  if (type && type !== "ALL" && !allowedTypes.has(String(type)))
    return next(badRequest("紀錄類型不正確。"));
  const filters = [];
  const params = [];
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(String(from))) {
    filters.push("DATE(r.occurred_at) >= ?");
    params.push(from);
  }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
    filters.push("DATE(r.occurred_at) <= ?");
    params.push(to);
  }
  if (type && type !== "ALL") {
    filters.push("r.event_type = ?");
    params.push(type);
  }
  if (warehouseId) {
    const id = Number(warehouseId);
    if (!Number.isInteger(id) || id < 1) return next(badRequest("倉庫選擇不正確。"));
    filters.push("r.warehouse_id = ?");
    params.push(id);
  }
  if (zoneCode) {
    filters.push("r.zone_code = ?");
    params.push(String(zoneCode).trim().toUpperCase());
  }
  if (keyword && String(keyword).trim()) {
    const like = `%${String(keyword).trim()}%`;
    filters.push("(r.product_name LIKE ? OR r.batch_no LIKE ? OR r.reference_no LIKE ? OR r.remark LIKE ? OR r.from_location LIKE ? OR r.to_location LIKE ?)");
    params.push(like, like, like, like, like, like);
  }
  try {
    const [rows] = await pool.execute(
      `SELECT r.* FROM (
         SELECT CONCAT('I-', t.transaction_id) AS record_id,
                t.transaction_date AS occurred_at, t.transaction_type AS event_type,
                p.product_name, b.batch_no, t.quantity, p.unit,
                CASE WHEN t.transaction_type = 'PURCHASE' THEN po.purchase_no
                     WHEN t.transaction_type = 'ADJUSTMENT' THEN CONCAT('盤點單 #', t.reference_id)
                     ELSE CONCAT('異動 #', t.transaction_id) END AS reference_no,
                NULL AS from_location, NULL AS to_location,
                cs.warehouse_id, w.warehouse_name, cs.zone_code, t.remark
         FROM inventory_transactions t
         JOIN products p ON p.product_id = t.product_id
         JOIN inventory_batches b ON b.batch_id = t.batch_id
         LEFT JOIN purchase_orders po ON t.transaction_type = 'PURCHASE' AND po.purchase_id = t.reference_id
         LEFT JOIN inventory_count_sessions cs ON t.transaction_type = 'ADJUSTMENT' AND cs.count_session_id = t.reference_id
         LEFT JOIN warehouses w ON w.warehouse_id = cs.warehouse_id

         UNION ALL

         SELECT CONCAT('L-', lt.location_transaction_id) AS record_id,
                lt.created_at AS occurred_at, lt.transaction_type AS event_type,
                p.product_name, b.batch_no, lt.quantity, p.unit,
                CONCAT('庫位異動 #', lt.location_transaction_id) AS reference_no,
                fl.location_code AS from_location, tl.location_code AS to_location,
                COALESCE(tl.warehouse_id, fl.warehouse_id) AS warehouse_id,
                w.warehouse_name,
                COALESCE(tl.zone_code, fl.zone_code) AS zone_code, lt.remark
         FROM location_transactions lt
         JOIN inventory_batches b ON b.batch_id = lt.batch_id
         JOIN products p ON p.product_id = b.product_id
         LEFT JOIN warehouse_locations fl ON fl.location_id = lt.from_location_id
         LEFT JOIN warehouse_locations tl ON tl.location_id = lt.to_location_id
         LEFT JOIN warehouses w ON w.warehouse_id = COALESCE(tl.warehouse_id, fl.warehouse_id)
         WHERE lt.transaction_type <> 'COUNT'
       ) r
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY r.occurred_at DESC, r.record_id DESC
       LIMIT 500`,
      params,
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get("/api/count/batches", async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT b.batch_id, b.batch_no, b.expiry_date, b.quantity, b.status,
             p.product_name, p.unit, c.kg_per_unit AS kg_per_box
      FROM inventory_batches b
      JOIN products p ON p.product_id = b.product_id
      LEFT JOIN product_unit_conversions c ON c.product_id = p.product_id AND c.unit_name = '箱'
      ORDER BY p.product_name, b.received_date, b.batch_id
    `);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get("/api/count/sessions", async (req, res, next) => {
  const warehouseId = Number(req.query.warehouseId);
  if (!Number.isInteger(warehouseId) || warehouseId < 1) {
    return next(badRequest("倉庫編號不正確。"));
  }
  try {
    const [rows] = await pool.execute(
      `SELECT s.count_session_id, s.warehouse_id, w.warehouse_name,
              s.zone_code, s.status, s.created_at, s.completed_at,
              COUNT(l.count_line_id) AS total_lines,
              SUM(l.line_status = 'COUNTED') AS counted_lines
       FROM inventory_count_sessions s
       JOIN warehouses w ON w.warehouse_id = s.warehouse_id
       LEFT JOIN inventory_count_lines l ON l.count_session_id = s.count_session_id
       WHERE s.warehouse_id = ?
       GROUP BY s.count_session_id, s.warehouse_id, w.warehouse_name,
                s.zone_code, s.status, s.created_at, s.completed_at
       ORDER BY s.count_session_id DESC LIMIT 50`,
      [warehouseId],
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post("/api/count/sessions", async (req, res, next) => {
  const warehouseId = Number(req.body.warehouseId);
  const zoneCode = String(req.body.zoneCode || "").trim().toUpperCase();
  if (!Number.isInteger(warehouseId) || warehouseId < 1 || !zoneCode) {
    return next(badRequest("請選擇倉庫和區域。"));
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [warehouses] = await connection.execute(
      "SELECT warehouse_id FROM warehouses WHERE warehouse_id = ? FOR UPDATE",
      [warehouseId],
    );
    if (!warehouses.length) throw badRequest("找不到這個倉庫。");
    const [locations] = await connection.execute(
      `SELECT location_id FROM warehouse_locations
       WHERE warehouse_id = ? AND zone_code = ? AND is_active = TRUE
       ORDER BY location_id FOR UPDATE`,
      [warehouseId, zoneCode],
    );
    if (!locations.length) throw badRequest("這個區域沒有可盤點的格位。");
    const [active] = await connection.execute(
      `SELECT count_session_id FROM inventory_count_sessions
       WHERE warehouse_id = ? AND zone_code = ? AND status IN ('COUNTING', 'REVIEW')
       LIMIT 1 FOR UPDATE`,
      [warehouseId, zoneCode],
    );
    if (active.length) throw conflict("這個區域已有尚未完成的盤點單。");
    const [result] = await connection.execute(
      "INSERT INTO inventory_count_sessions (warehouse_id, zone_code) VALUES (?, ?)",
      [warehouseId, zoneCode],
    );
    await connection.execute(
      `INSERT INTO inventory_count_lines
         (count_session_id, location_id, expected_batch_id, expected_quantity)
       SELECT ?, l.location_id, bl.batch_id, COALESCE(bl.quantity, 0)
       FROM warehouse_locations l
       LEFT JOIN batch_locations bl ON bl.location_id = l.location_id
       WHERE l.warehouse_id = ? AND l.zone_code = ? AND l.is_active = TRUE`,
      [result.insertId, warehouseId, zoneCode],
    );
    await connection.commit();
    res.status(201).json({ countSessionId: result.insertId });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.get("/api/count/sessions/:id", async (req, res, next) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId < 1) {
    return next(badRequest("盤點單編號不正確。"));
  }
  try {
    const [sessions] = await pool.execute(
      `SELECT s.count_session_id, s.warehouse_id, w.warehouse_name,
              s.zone_code, s.status, s.created_at, s.completed_at
       FROM inventory_count_sessions s
       JOIN warehouses w ON w.warehouse_id = s.warehouse_id
       WHERE s.count_session_id = ?`,
      [sessionId],
    );
    if (!sessions.length) throw badRequest("找不到這張盤點單。");
    const session = sessions[0];
    const revealExpected = ["REVIEW", "COMPLETED"].includes(session.status);
    const [lines] = await pool.execute(
      `SELECT cl.count_line_id, cl.location_id, l.location_code,
              l.row_no, l.column_no, cl.line_status,
              cl.counted_batch_id, cl.counted_quantity, cl.counted_box_count,
              cl.counted_loose_quantity_kg, cl.variance_reason,
              CASE WHEN ? THEN cl.expected_batch_id ELSE NULL END AS expected_batch_id,
              CASE WHEN ? THEN cl.expected_quantity ELSE NULL END AS expected_quantity,
              CASE WHEN ? THEN ep.product_name ELSE NULL END AS expected_product_name,
              CASE WHEN ? THEN eb.batch_no ELSE NULL END AS expected_batch_no,
              cp.product_name AS counted_product_name,
              cb.batch_no AS counted_batch_no,
              COALESCE(ep.unit, cp.unit) AS unit
       FROM inventory_count_lines cl
       JOIN warehouse_locations l ON l.location_id = cl.location_id
       LEFT JOIN inventory_batches eb ON eb.batch_id = cl.expected_batch_id
       LEFT JOIN products ep ON ep.product_id = eb.product_id
       LEFT JOIN inventory_batches cb ON cb.batch_id = cl.counted_batch_id
       LEFT JOIN products cp ON cp.product_id = cb.product_id
       WHERE cl.count_session_id = ?
       ORDER BY l.row_no, l.column_no, l.location_code`,
      [revealExpected, revealExpected, revealExpected, revealExpected, sessionId],
    );
    res.json({ session, lines });
  } catch (error) {
    next(error);
  }
});

app.put("/api/count/sessions/:sessionId/lines/:lineId", async (req, res, next) => {
  const sessionId = Number(req.params.sessionId);
  const lineId = Number(req.params.lineId);
  const countedBatchId = req.body.batchId ? Number(req.body.batchId) : null;
  let countedQuantity = Number(req.body.quantity);
  let countedBoxCount = 0;
  let countedLooseKg = 0;
  const useBoxCount = req.body.boxCount !== undefined;
  if (useBoxCount) {
    countedBoxCount = Number(req.body.boxCount);
    countedLooseKg = Number(req.body.looseKg);
    if (!Number.isInteger(countedBoxCount) || countedBoxCount < 0 || !Number.isFinite(countedLooseKg) || countedLooseKg < 0)
      return next(badRequest("箱數須為非負整數，散裝重量須為非負公斤數。"));
  }
  const reason = String(req.body.reason || "").trim().slice(0, 255);
  if (
    !Number.isInteger(sessionId) || sessionId < 1 ||
    !Number.isInteger(lineId) || lineId < 1 ||
    (!useBoxCount && (!Number.isFinite(countedQuantity) || countedQuantity < 0)) ||
    (countedBatchId !== null && (!Number.isInteger(countedBatchId) || countedBatchId < 1))
  ) {
    return next(badRequest("請確認實際批次與數量；空格位數量請填 0 並選擇「無庫存」。"));
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [sessions] = await connection.execute(
      "SELECT status FROM inventory_count_sessions WHERE count_session_id = ? FOR UPDATE",
      [sessionId],
    );
    if (!sessions.length || sessions[0].status !== "COUNTING") {
      throw conflict("這張盤點單目前不能再修改。");
    }
    const [lines] = await connection.execute(
      "SELECT expected_batch_id, expected_quantity FROM inventory_count_lines WHERE count_line_id = ? AND count_session_id = ? FOR UPDATE",
      [lineId, sessionId],
    );
    if (!lines.length) throw badRequest("找不到這筆格位盤點資料。");
    if (countedBatchId !== null) {
      const [batches] = await connection.execute(
        `SELECT b.batch_id, p.unit, c.kg_per_unit AS kg_per_box
         FROM inventory_batches b JOIN products p ON p.product_id = b.product_id
         LEFT JOIN product_unit_conversions c ON c.product_id = p.product_id AND c.unit_name = '箱'
         WHERE b.batch_id = ?`,
        [countedBatchId],
      );
      if (!batches.length) throw badRequest("選取的商品批次不存在。");
      if (useBoxCount) {
        const kgPerBox = Number(batches[0].kg_per_box);
        if (batches[0].unit !== "kg" || !Number.isFinite(kgPerBox) || kgPerBox <= 0)
          throw badRequest("這個批次尚未設定每箱公斤換算值，請改用公斤數盤點或先設定商品的箱裝換算。");
        countedQuantity = Math.round((countedBoxCount * kgPerBox + countedLooseKg + Number.EPSILON) * 100) / 100;
      }
    } else if (useBoxCount && (countedBoxCount !== 0 || countedLooseKg !== 0)) {
      throw badRequest("空格位請將箱數與散裝重量都填 0。" );
    }
    if (!Number.isFinite(countedQuantity) || countedQuantity < 0 ||
        (countedQuantity > 0 && countedBatchId === null) ||
        (countedQuantity === 0 && countedBatchId !== null))
      throw badRequest("請確認實際批次與數量；空格位數量請填 0 並選擇「無庫存」。");
    const variance =
      Number(lines[0].expected_quantity) !== countedQuantity ||
      Number(lines[0].expected_batch_id || 0) !== Number(countedBatchId || 0);
    if (variance && !reason) throw badRequest("數量或批次與帳面不同，請填寫差異原因。");
    await connection.execute(
      `UPDATE inventory_count_lines
       SET counted_batch_id = ?, counted_quantity = ?, counted_box_count = ?,
           counted_loose_quantity_kg = ?, line_status = 'COUNTED',
           variance_reason = ?, counted_at = CURRENT_TIMESTAMP
       WHERE count_line_id = ?`,
      [countedBatchId, countedQuantity, countedBoxCount, countedLooseKg, reason || null, lineId],
    );
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.post("/api/count/sessions/:id/review", async (req, res, next) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId < 1) {
    return next(badRequest("盤點單編號不正確。"));
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [sessions] = await connection.execute(
      "SELECT status FROM inventory_count_sessions WHERE count_session_id = ? FOR UPDATE",
      [sessionId],
    );
    if (!sessions.length || sessions[0].status !== "COUNTING") {
      throw conflict("這張盤點單目前不能送出審查。");
    }
    const [pending] = await connection.execute(
      "SELECT COUNT(*) AS pending FROM inventory_count_lines WHERE count_session_id = ? AND line_status <> 'COUNTED'",
      [sessionId],
    );
    if (Number(pending[0].pending) > 0) throw badRequest("還有格位尚未盤點，請完成所有格位後再檢視差異。");
    await connection.execute(
      "UPDATE inventory_count_sessions SET status = 'REVIEW' WHERE count_session_id = ?",
      [sessionId],
    );
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.post("/api/count/sessions/:id/reopen", async (req, res, next) => {
  const sessionId = Number(req.params.id);
  try {
    const [result] = await pool.execute(
      "UPDATE inventory_count_sessions SET status = 'COUNTING' WHERE count_session_id = ? AND status = 'REVIEW'",
      [sessionId],
    );
    if (!result.affectedRows) throw conflict("這張盤點單目前不能返回編輯。");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/count/sessions/:id/cancel", async (req, res, next) => {
  const sessionId = Number(req.params.id);
  try {
    const [result] = await pool.execute(
      "UPDATE inventory_count_sessions SET status = 'CANCELLED' WHERE count_session_id = ? AND status = 'COUNTING'",
      [sessionId],
    );
    if (!result.affectedRows) throw conflict("只有盤點中的單據可以取消。");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/count/sessions/:id/apply", async (req, res, next) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId < 1) {
    return next(badRequest("盤點單編號不正確。"));
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [sessions] = await connection.execute(
      "SELECT status FROM inventory_count_sessions WHERE count_session_id = ? FOR UPDATE",
      [sessionId],
    );
    if (!sessions.length || sessions[0].status !== "REVIEW") {
      throw conflict("請先完成盤點並檢視差異，再套用調整。");
    }
    const [lines] = await connection.execute(
      `SELECT cl.count_line_id, cl.location_id, cl.expected_batch_id,
              cl.expected_quantity, cl.counted_batch_id, cl.counted_quantity,
              cl.variance_reason, bl.batch_id AS current_batch_id,
              bl.quantity AS current_quantity, l.location_code
       FROM inventory_count_lines cl
       JOIN warehouse_locations l ON l.location_id = cl.location_id
       LEFT JOIN batch_locations bl ON bl.location_id = cl.location_id
       WHERE cl.count_session_id = ? AND cl.line_status = 'COUNTED'
       ORDER BY cl.location_id FOR UPDATE`,
      [sessionId],
    );
    if (!lines.length) throw badRequest("盤點單沒有可套用的明細。");
    for (const line of lines) {
      const currentBatch = Number(line.current_batch_id || 0);
      const expectedBatch = Number(line.expected_batch_id || 0);
      const currentQuantity = Number(line.current_quantity || 0);
      const expectedQuantity = Number(line.expected_quantity || 0);
      if (currentBatch !== expectedBatch || Math.abs(currentQuantity - expectedQuantity) > 0.000001) {
        throw conflict(`格位 ${line.location_code} 的帳面庫存已在盤點期間改變，請取消或重新盤點。`);
      }
    }

    const deltas = new Map();
    for (const line of lines) {
      const expectedBatch = Number(line.expected_batch_id || 0);
      const countedBatch = Number(line.counted_batch_id || 0);
      const expectedQuantity = Number(line.expected_quantity || 0);
      const countedQuantity = Number(line.counted_quantity || 0);
      if (expectedBatch) deltas.set(expectedBatch, (deltas.get(expectedBatch) || 0) - expectedQuantity);
      if (countedBatch) deltas.set(countedBatch, (deltas.get(countedBatch) || 0) + countedQuantity);
    }
    const batchIds = [...deltas.keys()].sort((a, b) => a - b);
    let batchRows = [];
    if (batchIds.length) {
      const placeholders = batchIds.map(() => "?").join(",");
      [batchRows] = await connection.execute(
        `SELECT batch_id, product_id, quantity FROM inventory_batches WHERE batch_id IN (${placeholders}) ORDER BY batch_id FOR UPDATE`,
        batchIds,
      );
    }
    const batchMap = new Map(batchRows.map((row) => [Number(row.batch_id), row]));
    for (const batchId of batchIds) {
      const batch = batchMap.get(batchId);
      if (!batch) throw badRequest(`找不到批次 ${batchId}，不能套用盤點結果。`);
      const delta = deltas.get(batchId);
      const newQuantity = Number(batch.quantity) + delta;
      if (newQuantity < -0.000001) throw conflict(`批次 ${batchId} 的總庫存不足以套用此差異。`);
      if (Math.abs(delta) > 0.000001) {
        await connection.execute(
          `UPDATE inventory_batches
           SET quantity = ?,
               status = CASE
                 WHEN ? <= 0.000001 THEN 'DEPLETED'
                 WHEN expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE() THEN 'EXPIRED'
                 ELSE 'AVAILABLE'
               END
           WHERE batch_id = ?`,
          [Math.max(0, newQuantity), newQuantity, batchId],
        );
        const direction = delta > 0 ? "增加" : "減少";
        await connection.execute(
          `INSERT INTO inventory_transactions
           (product_id, batch_id, transaction_type, quantity, reference_id, remark)
           VALUES (?, ?, 'ADJUSTMENT', ?, ?, ?)`,
          [batch.product_id, batchId, Math.abs(delta), sessionId, `盤點單#${sessionId} 庫存${direction}`],
        );
      }
    }

    for (const line of lines) {
      const expectedBatch = Number(line.expected_batch_id || 0);
      const countedBatch = Number(line.counted_batch_id || 0);
      const expectedQuantity = Number(line.expected_quantity || 0);
      const countedQuantity = Number(line.counted_quantity || 0);
      if (expectedBatch && expectedBatch === countedBatch && countedQuantity > 0) {
        await connection.execute(
          "UPDATE batch_locations SET quantity = ? WHERE location_id = ?",
          [countedQuantity, line.location_id],
        );
      } else {
        await connection.execute("DELETE FROM batch_locations WHERE location_id = ?", [line.location_id]);
      }
      if (countedBatch && countedQuantity > 0 && !(expectedBatch && expectedBatch === countedBatch)) {
        await connection.execute(
          "INSERT INTO batch_locations (location_id, batch_id, quantity) VALUES (?, ?, ?)",
          [line.location_id, countedBatch, countedQuantity],
        );
      }
      if (expectedBatch && countedBatch && expectedBatch === countedBatch) {
        await connection.execute(
          `INSERT INTO location_transactions
             (batch_id, from_location_id, to_location_id, quantity, transaction_type, remark)
           VALUES (?, ?, ?, ?, 'COUNT', ?)`,
          [countedBatch, line.location_id, line.location_id, Math.max(expectedQuantity, countedQuantity), `盤點單#${sessionId} 格位 ${line.location_code}`],
        );
      } else {
        if (expectedBatch && expectedQuantity > 0) {
          await connection.execute(
            `INSERT INTO location_transactions
               (batch_id, from_location_id, quantity, transaction_type, remark)
             VALUES (?, ?, ?, 'COUNT', ?)`,
            [expectedBatch, line.location_id, expectedQuantity, `盤點單#${sessionId} 格位移除`],
          );
        }
        if (countedBatch && countedQuantity > 0) {
          await connection.execute(
            `INSERT INTO location_transactions
               (batch_id, to_location_id, quantity, transaction_type, remark)
             VALUES (?, ?, ?, 'COUNT', ?)`,
            [countedBatch, line.location_id, countedQuantity, `盤點單#${sessionId} 格位放入`],
          );
        }
      }
    }
    await connection.execute(
      "UPDATE inventory_count_sessions SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE count_session_id = ?",
      [sessionId],
    );
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    connection?.release();
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.status || (error.code === "ER_DUP_ENTRY" ? 409 : 500);
  res
    .status(status)
    .json({
      message:
        status === 500
          ? "伺服器處理失敗，請檢查資料庫連線或欄位設定。"
          : error.message,
    });
});

app.listen(port, () =>
  console.log(`Productstock UI/API is running at http://localhost:${port}`),
);
