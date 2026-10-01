const recordTypeLabels = {
  PURCHASE: "進貨",
  SALE: "出貨",
  WASTE: "報廢",
  RETURN: "退貨",
  ADJUSTMENT: "盤點調整",
  MOVE: "倉位移動",
  PUTAWAY: "上架",
  PICK: "出庫揀貨",
};

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function recordsApi(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "紀錄載入失敗，請稍後再試。");
  return data;
}

async function loadRecordWarehouses() {
  const warehouses = await recordsApi("/api/warehouses");
  const select = document.getElementById("filterWarehouse");
  warehouses.forEach((warehouse) =>
    select.add(new Option(warehouse.warehouse_name, warehouse.warehouse_id)),
  );
}

async function loadRecordZones() {
  const warehouseId = document.getElementById("filterWarehouse").value;
  const zoneSelect = document.getElementById("filterZone");
  zoneSelect.replaceChildren(new Option("全部區域", ""));
  zoneSelect.disabled = !warehouseId;
  if (!warehouseId) return;
  const locations = await recordsApi(`/api/warehouses/${warehouseId}/map`);
  [...new Set(locations.map((location) => location.zone_code))]
    .sort((a, b) => a.localeCompare(b, "zh-TW", { numeric: true }))
    .forEach((zone) => zoneSelect.add(new Option(`區域 ${zone}`, zone)));
}

function recordQuantity(record) {
  const quantity = Number(record.quantity || 0);
  let sign = "";
  if (["PURCHASE", "RETURN"].includes(record.event_type)) sign = "+";
  if (["SALE", "WASTE"].includes(record.event_type)) sign = "−";
  if (record.event_type === "ADJUSTMENT") {
    if (String(record.remark || "").includes("減少")) sign = "−";
    else if (String(record.remark || "").includes("增加")) sign = "+";
  }
  return `${sign}${quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${record.unit || ""}`.trim();
}

function recordCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.className = `px-4 py-3 ${className}`.trim();
  cell.textContent = value == null || value === "" ? "—" : String(value);
  row.appendChild(cell);
  return cell;
}

function renderRecordSummary(records) {
  const count = (types) => records.filter((record) => types.includes(record.event_type)).length;
  document.getElementById("summaryPurchase").textContent = `${count(["PURCHASE"])} 筆`;
  document.getElementById("summarySale").textContent = `${count(["SALE"])} 筆`;
  document.getElementById("summaryWaste").textContent = `${count(["WASTE"])} 筆`;
  document.getElementById("summaryWarehouse").textContent = `${count(["ADJUSTMENT", "MOVE", "PUTAWAY", "PICK"])} 筆`;
}

function renderRecords(records) {
  const body = document.getElementById("recordsBody");
  body.replaceChildren();
  renderRecordSummary(records);
  document.getElementById("recordCount").textContent = `查到 ${records.length} 筆${records.length === 500 ? "（最多顯示 500 筆，請縮小日期範圍）" : ""}`;
  document.getElementById("recordStatus").textContent = records.length ? "依時間由新到舊" : "此條件沒有紀錄";
  if (!records.length) {
    const row = document.createElement("tr");
    const cell = recordCell(row, "找不到符合條件的紀錄。", "py-12 text-center text-slate-500");
    cell.colSpan = 7;
    body.appendChild(row);
    return;
  }
  records.forEach((record) => {
    const row = document.createElement("tr");
    row.className = "align-top hover:bg-slate-50";
    recordCell(row, String(record.occurred_at || "").slice(0, 16), "whitespace-nowrap text-xs tabular-nums text-slate-600");
    const typeCell = recordCell(row, "");
    const badge = document.createElement("span");
    const color = {
      PURCHASE: "bg-emerald-100 text-emerald-800",
      SALE: "bg-blue-100 text-blue-800",
      WASTE: "bg-rose-100 text-rose-800",
      RETURN: "bg-cyan-100 text-cyan-800",
      ADJUSTMENT: "bg-amber-100 text-amber-800",
      MOVE: "bg-violet-100 text-violet-800",
      PUTAWAY: "bg-indigo-100 text-indigo-800",
      PICK: "bg-slate-200 text-slate-700",
    }[record.event_type] || "bg-slate-100 text-slate-700";
    badge.className = `inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${color}`;
    badge.textContent = recordTypeLabels[record.event_type] || record.event_type;
    typeCell.appendChild(badge);
    const productCell = recordCell(row, "");
    const productName = document.createElement("div");
    productName.className = "font-semibold text-slate-800";
    productName.textContent = record.product_name || "—";
    const batchNo = document.createElement("div");
    batchNo.className = "mt-0.5 text-xs text-slate-500";
    batchNo.textContent = record.batch_no || "";
    productCell.append(productName, batchNo);
    recordCell(row, recordQuantity(record), "whitespace-nowrap text-right font-semibold tabular-nums");
    recordCell(row, record.reference_no, "whitespace-nowrap text-xs text-slate-600");
    const location = record.from_location || record.to_location
      ? `${record.warehouse_name || "倉庫"}${record.zone_code ? ` · ${record.zone_code}區` : ""} · ${record.from_location || "未上架"} → ${record.to_location || "已出庫"}`
      : record.warehouse_name
        ? `${record.warehouse_name}${record.zone_code ? ` · ${record.zone_code}區` : ""}`
        : "—";
    recordCell(row, location, "text-xs text-slate-600");
    recordCell(row, record.remark, "max-w-xs whitespace-normal text-xs text-slate-600");
    body.appendChild(row);
  });
}

async function queryRecords(event) {
  event?.preventDefault();
  const form = document.getElementById("recordFilterForm");
  const params = new URLSearchParams();
  ["filterFrom", "filterTo", "filterType", "filterWarehouse", "filterZone", "filterKeyword"].forEach((id) => {
    const input = document.getElementById(id);
    const value = input.value.trim();
    if (value && !(id === "filterType" && value === "ALL"))
      params.set(({ filterFrom: "from", filterTo: "to", filterType: "type", filterWarehouse: "warehouseId", filterZone: "zoneCode", filterKeyword: "keyword" })[id], value);
  });
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  document.getElementById("recordStatus").textContent = "正在查詢…";
  try {
    renderRecords(await recordsApi(`/api/records?${params}`));
  } catch (error) {
    document.getElementById("recordsBody").replaceChildren();
    const row = document.createElement("tr");
    const cell = recordCell(row, error.message, "py-12 text-center text-rose-700");
    cell.colSpan = 7;
    document.getElementById("recordsBody").appendChild(row);
    document.getElementById("recordStatus").textContent = "查詢失敗";
  } finally {
    button.disabled = false;
  }
}

document.getElementById("recordFilterForm").addEventListener("submit", queryRecords);
document.getElementById("filterWarehouse").addEventListener("change", async () => {
  try {
    await loadRecordZones();
  } catch (error) {
    document.getElementById("recordStatus").textContent = error.message;
  }
});
document.getElementById("resetFilters").addEventListener("click", async () => {
  document.getElementById("recordFilterForm").reset();
  document.getElementById("filterFrom").value = todayString();
  document.getElementById("filterTo").value = todayString();
  await loadRecordZones();
  await queryRecords();
});

document.getElementById("filterFrom").value = todayString();
document.getElementById("filterTo").value = todayString();
loadRecordWarehouses()
  .then(queryRecords)
  .catch((error) => {
    document.getElementById("recordStatus").textContent = error.message;
    queryRecords();
  });
