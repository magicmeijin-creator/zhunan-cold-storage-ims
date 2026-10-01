let countWarehouses = [];
let countZones = [];
let countBatches = [];
let countSession = null;
let countLines = [];
let editingLineId = null;

async function countApi(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "操作失敗，請稍後再試。");
  return data;
}

function countNotify(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.classList.toggle("bg-rose-700", isError);
  toast.classList.toggle("bg-slate-900", !isError);
  clearTimeout(countNotify.timer);
  countNotify.timer = setTimeout(() => toast.classList.add("hidden"), 4000);
}

function closeCountDialog() {
  document.getElementById("countLineDialog").close();
}

function selectedWarehouseId() {
  return document.getElementById("warehouseSelect").value;
}

function selectedZoneCode() {
  return document.getElementById("zoneSelect").value;
}

function fmtQuantity(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function selectedCountBatch() {
  const id = document.getElementById("countedBatchSelect").value;
  return countBatches.find((batch) => String(batch.batch_id) === id);
}

function updateCountUnitInputs() {
  const batch = selectedCountBatch();
  const kgPerBox = Number(batch?.kg_per_box);
  const useBoxes = batch?.unit === "kg" && Number.isFinite(kgPerBox) && kgPerBox > 0;
  document.getElementById("countedBoxFields").classList.toggle("hidden", !useBoxes);
  document.getElementById("countedQuantityField").classList.toggle("hidden", useBoxes);
  document.getElementById("countedQuantity").required = !useBoxes;
  document.getElementById("countedBoxCount").required = useBoxes;
  document.getElementById("countedLooseKg").required = useBoxes;
  document.getElementById("countedBoxWeightLabel").textContent = useBoxes ? `(每箱 ${fmtQuantity(kgPerBox)} kg)` : "";
  const boxes = Number(document.getElementById("countedBoxCount").value) || 0;
  const loose = Number(document.getElementById("countedLooseKg").value) || 0;
  document.getElementById("countedTotalKg").textContent = (boxes * (useBoxes ? kgPerBox : 0) + loose).toFixed(2);
}

async function loadCountWarehouses() {
  countWarehouses = await countApi("/api/warehouses");
  const select = document.getElementById("warehouseSelect");
  select.replaceChildren();
  countWarehouses.forEach((warehouse) =>
    select.add(new Option(warehouse.warehouse_name, warehouse.warehouse_id)),
  );
  if (!countWarehouses.length) {
    select.add(new Option("尚未建立倉庫", ""));
    document.getElementById("startCountButton").disabled = true;
    return;
  }
  await loadZonesAndHistory();
}

async function loadZonesAndHistory() {
  const warehouseId = selectedWarehouseId();
  const zoneSelect = document.getElementById("zoneSelect");
  zoneSelect.replaceChildren();
  if (!warehouseId) return;
  const locations = await countApi(`/api/warehouses/${warehouseId}/map`);
  countZones = [...new Set(locations.map((location) => location.zone_code))];
  countZones.forEach((zone) => zoneSelect.add(new Option(`區域 ${zone}`, zone)));
  document.getElementById("startCountButton").disabled = countZones.length === 0;
  await loadCountHistory();
}

async function loadCountHistory(preferredSessionId) {
  const warehouseId = selectedWarehouseId();
  const select = document.getElementById("historySelect");
  select.replaceChildren();
  if (!warehouseId) {
    select.add(new Option("尚無盤點紀錄", ""));
    return;
  }
  const sessions = await countApi(`/api/count/sessions?warehouseId=${warehouseId}`);
  if (!sessions.length) {
    select.add(new Option("尚無盤點紀錄", ""));
    return;
  }
  select.add(new Option("選擇盤點紀錄…", ""));
  sessions.forEach((session) => {
    const label = `#${session.count_session_id} · ${session.zone_code}區 · ${statusLabel(session.status)} · ${session.counted_lines || 0}/${session.total_lines}`;
    select.add(new Option(label, session.count_session_id));
  });
  if (preferredSessionId) select.value = String(preferredSessionId);
}

async function loadCountSession(sessionId) {
  const data = await countApi(`/api/count/sessions/${sessionId}`);
  countSession = data.session;
  countLines = data.lines;
  renderCountSession();
}

function statusLabel(status) {
  return ({ COUNTING: "盤點中", REVIEW: "待確認差異", COMPLETED: "已完成", CANCELLED: "已取消" })[status] || status;
}

function renderCountSession() {
  const panel = document.getElementById("sessionPanel");
  if (!countSession) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  const counted = countLines.filter((line) => line.line_status === "COUNTED").length;
  const total = countLines.length;
  document.getElementById("sessionTitle").textContent = `${countSession.warehouse_name} · 區域 ${countSession.zone_code}`;
  document.getElementById("sessionStatus").textContent = statusLabel(countSession.status);
  document.getElementById("sessionCreated").textContent = `盤點單 #${countSession.count_session_id} · 建立時間 ${String(countSession.created_at).slice(0, 16)}`;
  document.getElementById("progressText").textContent = `${counted} / ${total} 格`;
  document.getElementById("progressBar").style.width = `${total ? (counted / total) * 100 : 0}%`;

  const isCounting = countSession.status === "COUNTING";
  const isReview = countSession.status === "REVIEW";
  document.getElementById("countingPanel").classList.toggle("hidden", !isCounting);
  document.getElementById("reviewPanel").classList.toggle("hidden", !(isReview || countSession.status === "COMPLETED"));
  document.getElementById("cancelCountButton").classList.toggle("hidden", !isCounting);
  document.getElementById("updateWarehouseButton").disabled = counted !== total || total === 0;
  document.getElementById("updateWarehouseButton").classList.toggle("hidden", !isCounting);
  document.getElementById("reopenButton").classList.toggle("hidden", !isReview);
  document.getElementById("applyButton").classList.toggle("hidden", !isReview);
  document.getElementById("applyButton").textContent = "更新倉儲狀況";
  document.getElementById("applyButton").disabled = !isReview;
  renderCountLines();
  if (isReview || countSession.status === "COMPLETED") renderCountReview();
}

function renderCountLines() {
  const body = document.getElementById("countLinesBody");
  body.replaceChildren();
  countLines.forEach((line) => {
    const row = document.createElement("tr");
    const location = document.createElement("td");
    location.className = "px-4 py-3 font-semibold";
    location.textContent = line.location_code;
    row.appendChild(location);
    const status = document.createElement("td");
    status.className = "px-4 py-3";
    const badge = document.createElement("span");
    badge.className = line.line_status === "COUNTED" ? "rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800" : "rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800";
    badge.textContent = line.line_status === "COUNTED" ? "已記錄" : "待盤點";
    status.appendChild(badge);
    row.appendChild(status);
    const action = document.createElement("td");
    action.className = "px-4 py-3 text-right";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50";
    edit.textContent = line.line_status === "COUNTED" ? "修改" : "輸入實盤";
    edit.addEventListener("click", () => openCountLine(line));
    action.appendChild(edit);
    row.appendChild(action);
    body.appendChild(row);
  });
}

async function openCountLine(line) {
  editingLineId = line.count_line_id;
  if (!countBatches.length) countBatches = await countApi("/api/count/batches");
  const select = document.getElementById("countedBatchSelect");
  select.replaceChildren();
  select.add(new Option("無庫存／空格位", "none"));
  countBatches.forEach((batch) => {
    const boxHint = Number(batch.kg_per_box) > 0 ? ` · 1箱=${fmtQuantity(batch.kg_per_box)}kg` : "";
    const label = `${batch.product_name} · ${batch.batch_no} · ${batch.status} · ${batch.unit}${boxHint} · 效期 ${batch.expiry_date || "未設定"}`;
    select.add(new Option(label, batch.batch_id));
  });
  const none = !line.counted_batch_id;
  select.value = none ? "none" : String(line.counted_batch_id);
  document.getElementById("countLineLocation").textContent = `盤點格位：${line.location_code}`;
  document.getElementById("countedQuantity").value = line.counted_quantity ?? 0;
  document.getElementById("countedBoxCount").value = line.counted_box_count ?? 0;
  document.getElementById("countedLooseKg").value = line.counted_loose_quantity_kg ?? 0;
  document.getElementById("varianceReason").value = line.variance_reason || "";
  updateCountUnitInputs();
  document.getElementById("countLineDialog").showModal();
}

function reviewText(productName, batchNo) {
  return productName ? `${productName} · ${batchNo || "批次未設定"}` : "無庫存／空格位";
}

function renderCountReview() {
  const body = document.getElementById("reviewLinesBody");
  body.replaceChildren();
  let discrepancyCount = 0;
  countLines.forEach((line) => {
    const expectedQty = Number(line.expected_quantity || 0);
    const countedQty = Number(line.counted_quantity || 0);
    const batchMismatch = Number(line.expected_batch_id || 0) !== Number(line.counted_batch_id || 0);
    const delta = countedQty - expectedQty;
    const hasDifference = batchMismatch || Math.abs(delta) > 0.000001;
    if (hasDifference) discrepancyCount += 1;
    const row = document.createElement("tr");
    if (hasDifference) row.className = "bg-amber-50/50";
    const values = [
      line.location_code,
      reviewText(line.expected_product_name, line.expected_batch_no),
      fmtQuantity(expectedQty),
      reviewText(line.counted_product_name, line.counted_batch_no),
      (line.counted_box_count || line.counted_loose_quantity_kg)
        ? `${line.counted_box_count} 箱 + ${fmtQuantity(line.counted_loose_quantity_kg)} kg (${fmtQuantity(countedQty)} kg)`
        : `${fmtQuantity(countedQty)} ${line.unit || ""}`,
      hasDifference ? `${batchMismatch ? "批次不同；" : ""}${delta > 0 ? "+" : ""}${fmtQuantity(delta)} · ${line.variance_reason || "未填原因"}` : "一致",
    ];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      cell.className = `px-4 py-3 ${index === 2 || index === 4 ? "text-right tabular-nums" : ""} ${hasDifference && index === 5 ? "font-semibold text-amber-900" : ""}`;
      cell.textContent = value;
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  document.getElementById("reviewSummary").textContent = discrepancyCount
    ? `共 ${discrepancyCount} 格有差異；確認後將以實盤批次與數量更新庫存，並保留調整紀錄。`
    : "所有格位均與帳面相符，確認後會完成盤點且不產生庫存調整。";
}

document.getElementById("warehouseSelect").addEventListener("change", async () => {
  countSession = null;
  countLines = [];
  document.getElementById("sessionPanel").classList.add("hidden");
  try { await loadZonesAndHistory(); } catch (error) { countNotify(error.message, true); }
});

document.getElementById("zoneSelect").addEventListener("change", () => {
  countSession = null;
  countLines = [];
  document.getElementById("sessionPanel").classList.add("hidden");
});

document.getElementById("historySelect").addEventListener("change", async (event) => {
  if (!event.target.value) return;
  try { await loadCountSession(event.target.value); } catch (error) { countNotify(error.message, true); }
});

document.getElementById("startCountButton").addEventListener("click", async () => {
  try {
    const result = await countApi("/api/count/sessions", {
      method: "POST",
      body: JSON.stringify({ warehouseId: selectedWarehouseId(), zoneCode: selectedZoneCode() }),
    });
    await loadCountSession(result.countSessionId);
    await loadCountHistory(result.countSessionId);
    countNotify("盤點單已建立。請依格位逐一記錄現場批次與數量。");
  } catch (error) { countNotify(error.message, true); }
});

document.getElementById("countLineForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const batchValue = document.getElementById("countedBatchSelect").value;
  const batch = selectedCountBatch();
  const boxKg = Number(batch?.kg_per_box);
  const useBoxes = batch?.unit === "kg" && Number.isFinite(boxKg) && boxKg > 0;
  const boxCount = Number(document.getElementById("countedBoxCount").value);
  const looseKg = Number(document.getElementById("countedLooseKg").value);
  const quantity = useBoxes
    ? boxCount * boxKg + looseKg
    : Number(document.getElementById("countedQuantity").value);
  if (useBoxes && (!Number.isInteger(boxCount) || boxCount < 0 || !Number.isFinite(looseKg) || looseKg < 0))
    return countNotify("箱數須為非負整數，散裝公斤須為非負數。", true);
  if ((batchValue === "none" && quantity !== 0) || (batchValue !== "none" && quantity <= 0)) {
    return countNotify("有庫存請選批次並輸入大於 0 的數量；空格請選「無庫存」並輸入 0。", true);
  }
  try {
    await countApi(`/api/count/sessions/${countSession.count_session_id}/lines/${editingLineId}`, {
      method: "PUT",
      body: JSON.stringify({
        batchId: batchValue === "none" ? null : batchValue,
        quantity,
        ...(useBoxes ? { boxCount, looseKg } : {}),
        reason: document.getElementById("varianceReason").value.trim(),
      }),
    });
    closeCountDialog();
    await loadCountSession(countSession.count_session_id);
    await loadCountHistory(countSession.count_session_id);
    countNotify("實盤結果已儲存。");
  } catch (error) { countNotify(error.message, true); }
});

document.getElementById("countedBatchSelect").addEventListener("change", () => {
  document.getElementById("countedQuantity").value = "0";
  document.getElementById("countedBoxCount").value = "0";
  document.getElementById("countedLooseKg").value = "0";
  updateCountUnitInputs();
});
document.getElementById("countedBoxCount").addEventListener("input", updateCountUnitInputs);
document.getElementById("countedLooseKg").addEventListener("input", updateCountUnitInputs);

document.getElementById("updateWarehouseButton").addEventListener("click", async (event) => {
  if (!countSession || countLines.some((line) => line.line_status !== "COUNTED")) return;
  const button = event.currentTarget;
  if (!window.confirm(`確認更新「${countSession.warehouse_name}・區域 ${countSession.zone_code}」的倉儲狀況？系統會依本次實盤結果調整格位與庫存，並保留盤點異動紀錄。`)) return;
  button.disabled = true;
  try {
    await countApi(`/api/count/sessions/${countSession.count_session_id}/review`, { method: "POST", body: "{}" });
    await countApi(`/api/count/sessions/${countSession.count_session_id}/apply`, { method: "POST", body: "{}" });
    await loadCountSession(countSession.count_session_id);
    await loadCountHistory(countSession.count_session_id);
    countNotify("倉儲狀況已更新，盤點差異與異動紀錄已保留。");
  } catch (error) {
    try {
      await loadCountSession(countSession.count_session_id);
      await loadCountHistory(countSession.count_session_id);
    } catch { /* Keep the original operation error visible. */ }
    countNotify(error.message, true);
  }
});

document.getElementById("reopenButton").addEventListener("click", async () => {
  try {
    await countApi(`/api/count/sessions/${countSession.count_session_id}/reopen`, { method: "POST", body: "{}" });
    await loadCountSession(countSession.count_session_id);
    await loadCountHistory(countSession.count_session_id);
  } catch (error) { countNotify(error.message, true); }
});

document.getElementById("applyButton").addEventListener("click", async () => {
  if (!window.confirm(`確認更新「${countSession.warehouse_name}・區域 ${countSession.zone_code}」的倉儲狀況？系統會依實盤結果調整格位與庫存。`)) return;
  try {
    await countApi(`/api/count/sessions/${countSession.count_session_id}/apply`, { method: "POST", body: "{}" });
    await loadCountSession(countSession.count_session_id);
    await loadCountHistory(countSession.count_session_id);
    countNotify("倉儲狀況已更新，盤點差異與異動紀錄已保留。");
  } catch (error) { countNotify(error.message, true); }
});

document.getElementById("cancelCountButton").addEventListener("click", async () => {
  if (!window.confirm("取消這張盤點單？已記錄的盤點數字會保留在歷史中，但不會調整庫存。")) return;
  try {
    await countApi(`/api/count/sessions/${countSession.count_session_id}/cancel`, { method: "POST", body: "{}" });
    await loadCountSession(countSession.count_session_id);
    await loadCountHistory(countSession.count_session_id);
    countNotify("盤點單已取消，格位操作已恢復。");
  } catch (error) { countNotify(error.message, true); }
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadCountWarehouses();
    countBatches = await countApi("/api/count/batches");
  } catch (error) { countNotify(error.message, true); }
});
