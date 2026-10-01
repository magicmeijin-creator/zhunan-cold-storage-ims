let inventoryItems = [];
let selectedCategory = "all";
let sortState = { key: "expiry", direction: 1 };
let overviewWarehouses = [];
let overviewLocations = [];
let overviewWarehouseId = "";
let overviewTargetBatchId = null;
let overviewSelectedZone = "";
let overviewSelectedLocationId = null;
let overviewTargetAutoScrolled = false;
const chineseStrokeCollator = new Intl.Collator("zh-TW-u-co-stroke", {
  usage: "sort",
  sensitivity: "base",
  numeric: true,
});

function localDateOffset(offsetDays) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function daysRemaining(value) {
  if (!value) return null;
  const parts = value.slice(0, 10).split("-").map(Number);
  const expiryUtc = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const today = new Date();
  const todayUtc = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  return Math.round((expiryUtc - todayUtc) / 86400000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "連線失敗，請稍後再試。");
  return data;
}

function textCell(parent, value, className = "") {
  const cell = document.createElement("td");
  cell.className = `py-3 px-4 ${className}`.trim();
  cell.textContent = value == null || value === "" ? "—" : String(value);
  parent.appendChild(cell);
  return cell;
}

function getVisibleItems() {
  const keyword = document
    .getElementById("searchInput")
    .value.trim()
    .toLocaleLowerCase();
  const status = document.getElementById("statusSelect").value;
  return inventoryItems
    .filter((item) => {
      if (selectedCategory !== "all" && item.category !== selectedCategory)
        return false;
      if (
        keyword &&
        ![item.name, item.origin, item.product_code, item.batch_no].some(
          (value) =>
            String(value || "")
              .toLocaleLowerCase()
              .includes(keyword),
        )
      )
        return false;
      const days = daysRemaining(item.expiryDate);
      if (status === "fresh" && (days === null || days <= 3)) return false;
      if (status === "expiring" && (days === null || days > 3)) return false;
      if (status === "expired" && (days === null || days >= 0)) return false;
      return true;
    })
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const a = left.item;
      const b = right.item;
      let result = 0;
      let nullsLast = false;
      if (sortState.key === "name") {
        result = chineseStrokeCollator.compare(a.name || "", b.name || "");
      } else if (sortState.key === "supplier") {
        result = chineseStrokeCollator.compare(a.origin || "", b.origin || "");
      } else if (sortState.key === "inboundDate") {
        result = String(a.inboundDate || "").localeCompare(String(b.inboundDate || ""));
      } else if (sortState.key === "receivedAt") {
        result = String(a.receivedAt || "").localeCompare(String(b.receivedAt || ""));
      } else if (sortState.key === "expiry") {
        const daysA = daysRemaining(a.expiryDate);
        const daysB = daysRemaining(b.expiryDate);
        nullsLast = true;
        result = daysA === null || daysB === null ? 0 : daysA - daysB;
        if (daysA === null && daysB !== null) return 1;
        if (daysA !== null && daysB === null) return -1;
      } else if (sortState.key === "qty") {
        result = Number(a.qty) - Number(b.qty);
      } else if (sortState.key === "unitCost") {
        result = Number(a.unitCostPerKg) - Number(b.unitCostPerKg);
      } else if (sortState.key === "status") {
        const statusRank = (item) => {
          const days = daysRemaining(item.expiryDate);
          return days === null ? 0 : days < 0 ? 3 : days <= 3 ? 2 : 1;
        };
        result = statusRank(a) - statusRank(b);
      }
      if (nullsLast && result === 0) return left.index - right.index;
      return result * sortState.direction || left.index - right.index;
    })
    .map(({ item }) => item);
}

function updateSortIndicators() {
  document.querySelectorAll("[data-sort-header]").forEach((header) => {
    const key = header.dataset.sortHeader;
    const active = key === sortState.key;
    header.setAttribute(
      "aria-sort",
      active ? (sortState.direction === 1 ? "ascending" : "descending") : "none",
    );
    const icon = header.querySelector("[data-sort-icon]");
    icon.className = `fa-solid ${active ? (sortState.direction === 1 ? "fa-arrow-up text-emerald-700" : "fa-arrow-down text-emerald-700") : "fa-sort text-slate-400"}`;
  });
}

function showOverviewTooltip(location, x, y) {
  const tooltip = document.getElementById("overviewMapTooltip");
  const occupied = location.batch_id != null;
  tooltip.textContent = occupied
    ? `${location.location_code}\n${location.product_name} · ${Number(location.stored_quantity).toLocaleString()} ${location.unit}\n批次 ${location.batch_no || "未設定"}`
    : `${location.location_code}\n空格位`;
  tooltip.classList.remove("hidden");
  tooltip.style.left = `${Math.min(x + 14, window.innerWidth - tooltip.offsetWidth - 12)}px`;
  tooltip.style.top = `${Math.min(y + 14, window.innerHeight - tooltip.offsetHeight - 12)}px`;
}

function selectOverviewLocation(location) {
  overviewSelectedLocationId = Number(location.location_id);
  const details = document.getElementById("overviewLocationDetails");
  details.className = "mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm";
  if (location.batch_id == null) {
    details.textContent = `${location.location_code} · 空格位`;
  } else {
    details.textContent = `${location.location_code} · ${location.product_name} · ${Number(location.stored_quantity).toLocaleString()} ${location.unit} · 批次 ${location.batch_no || "未設定"}`;
  }
  document.querySelectorAll("[data-overview-location]").forEach((button) => {
    button.classList.toggle(
      "ring-2",
      Number(button.dataset.overviewLocation) === overviewSelectedLocationId,
    );
    button.classList.toggle(
      "ring-blue-500",
      Number(button.dataset.overviewLocation) === overviewSelectedLocationId,
    );
  });
}

function renderWarehouseOverview() {
  const zonesHost = document.getElementById("overviewMapZones");
  const listHost = document.getElementById("overviewZoneList");
  const empty = document.getElementById("overviewMapEmpty");
  const loading = document.getElementById("overviewMapLoading");
  const selectedWarehouse = overviewWarehouses.find(
    (warehouse) => String(warehouse.warehouse_id) === overviewWarehouseId,
  );
  zonesHost.replaceChildren();
  listHost.replaceChildren();
  loading.classList.add("hidden");
  document.getElementById("overviewMapHeading").textContent =
    selectedWarehouse?.warehouse_name || "倉庫格位總覽";

  if (!overviewLocations.length) {
    empty.classList.remove("hidden");
    document.getElementById("overviewMapSummary").textContent = "";
    empty.textContent = selectedWarehouse ? "此倉庫尚未建立格位。" : "目前尚未建立倉庫。";
    document.getElementById("overviewZoneList").innerHTML =
      '<p class="text-sm text-slate-500">尚無倉庫區域可顯示。</p>';
    document.getElementById("overviewLocationDetails").textContent =
      "建立倉庫與區域後，即可查看商品位置。";
    return;
  }
  empty.classList.add("hidden");

  const zones = [...new Set(overviewLocations.map((location) => location.zone_code))]
    .sort((a, b) => a.localeCompare(b, "zh-TW", { numeric: true }));
  if (overviewTargetBatchId !== null) {
    const firstMatch = overviewLocations.find(
      (location) => Number(location.batch_id) === overviewTargetBatchId,
    );
    if (firstMatch && !overviewSelectedZone) overviewSelectedZone = firstMatch.zone_code;
  }
  const occupiedTotal = overviewLocations.filter((location) => location.batch_id != null).length;
  document.getElementById("overviewMapSummary").textContent =
    `${zones.length} 個區域 · ${overviewLocations.length} 格 · ${occupiedTotal} 格有庫存 · ${overviewLocations.length - occupiedTotal} 格空置`;

  if (overviewTargetBatchId !== null) {
    const matches = overviewLocations.filter(
      (location) => Number(location.batch_id) === overviewTargetBatchId,
    );
    document.getElementById("warehouseOverviewSubtitle").textContent = matches.length
      ? `已標示此批次所在的 ${matches.length} 個格位`
      : "此批次目前尚未上架到倉儲格位";
    if (!matches.length) {
      const batch = inventoryItems.find(
        (item) => Number(item.id) === overviewTargetBatchId,
      );
      document.getElementById("overviewLocationDetails").textContent = batch
        ? `${batch.name}（批次 ${batch.batch_no}）在此倉庫尚未上架。`
        : "此批次在此倉庫尚未上架。";
    }
  } else {
    document.getElementById("warehouseOverviewSubtitle").textContent = "快速查看商品所在倉庫與格位";
  }

  zones.forEach((zone) => {
    const area = overviewLocations.filter((location) => location.zone_code === zone);
    const occupied = area.filter((location) => location.batch_id != null).length;
    const maxColumn = Math.max(...area.map((location) => Number(location.column_no)));
    const section = document.createElement("section");
    section.dataset.overviewZone = zone;
    section.className = "scroll-mt-3 rounded-xl border border-slate-200 bg-white p-3 sm:p-4";
    const heading = document.createElement("div");
    heading.className = "mb-3 flex items-center justify-between gap-2";
    const title = document.createElement("h4");
    title.className = "font-bold text-slate-800";
    title.textContent = `區域 ${zone}`;
    const count = document.createElement("span");
    count.className = "text-xs text-slate-500";
    count.textContent = `${occupied}/${area.length} 格有庫存`;
    heading.append(title, count);
    section.appendChild(heading);

    const scroller = document.createElement("div");
    scroller.className = "overflow-x-auto pb-1";
    const grid = document.createElement("div");
    grid.className = "grid min-w-max gap-2";
    grid.style.gridTemplateColumns = `repeat(${maxColumn}, minmax(82px, 1fr))`;
    area.forEach((location) => {
      const button = document.createElement("button");
      const hasStock = location.batch_id != null;
      const isTarget = overviewTargetBatchId !== null &&
        Number(location.batch_id) === overviewTargetBatchId;
      button.type = "button";
      button.dataset.overviewLocation = location.location_id;
      button.style.gridColumn = String(location.column_no);
      button.style.gridRow = String(location.row_no);
      button.className = `flex min-h-[76px] flex-col justify-start rounded-lg border p-2 text-left transition hover:-translate-y-0.5 hover:shadow ${hasStock ? "border-emerald-200 bg-emerald-50 hover:border-emerald-400" : "border-slate-200 bg-slate-50 hover:border-slate-400"} ${isTarget ? "ring-2 ring-amber-500" : ""} ${Number(location.location_id) === overviewSelectedLocationId ? "ring-2 ring-blue-500" : ""}`;
      const code = document.createElement("span");
      code.className = "text-[10px] font-bold text-slate-500";
      code.textContent = location.location_code;
      const product = document.createElement("span");
      product.className = "mt-1 line-clamp-2 text-xs font-semibold text-slate-800";
      product.textContent = hasStock ? location.product_name : "空位";
      button.append(code, product);
      if (hasStock) {
        const quantity = document.createElement("span");
        quantity.className = "mt-1 text-[10px] text-slate-600";
        quantity.textContent = `${Number(location.stored_quantity).toLocaleString()} ${location.unit}`;
        button.appendChild(quantity);
      }
      button.addEventListener("pointerenter", (event) => {
        showOverviewTooltip(location, event.clientX, event.clientY);
      });
      button.addEventListener("pointermove", (event) => {
        showOverviewTooltip(location, event.clientX, event.clientY);
      });
      button.addEventListener("pointerleave", () => {
        document.getElementById("overviewMapTooltip").classList.add("hidden");
      });
      button.addEventListener("focus", () => {
        const rect = button.getBoundingClientRect();
        showOverviewTooltip(location, rect.left + rect.width / 2, rect.top + rect.height / 2);
        selectOverviewLocation(location);
      });
      button.addEventListener("blur", () => {
        document.getElementById("overviewMapTooltip").classList.add("hidden");
      });
      button.addEventListener("click", () => selectOverviewLocation(location));
      grid.appendChild(button);
    });
    scroller.appendChild(grid);
    section.appendChild(scroller);
    zonesHost.appendChild(section);

    const zoneButton = document.createElement("button");
    zoneButton.type = "button";
    zoneButton.className = `w-full rounded-xl border p-3 text-left transition hover:border-emerald-300 hover:bg-emerald-50 ${overviewSelectedZone === zone ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white"}`;
    const zoneName = document.createElement("span");
    zoneName.className = "flex items-center justify-between font-semibold text-slate-800";
    const zoneLabel = document.createElement("span");
    const zoneIcon = document.createElement("i");
    zoneIcon.className = "fa-solid fa-layer-group mr-2 text-emerald-700";
    zoneLabel.append(zoneIcon, document.createTextNode(`區域 ${zone}`));
    const arrowIcon = document.createElement("i");
    arrowIcon.className = "fa-solid fa-chevron-right text-xs text-slate-400";
    zoneName.append(zoneLabel, arrowIcon);
    const zoneSummary = document.createElement("span");
    zoneSummary.className = "mt-1 block pl-6 text-xs text-slate-500";
    zoneSummary.textContent = `${occupied} 格有庫存 · ${area.length - occupied} 格空置`;
    zoneButton.append(zoneName, zoneSummary);
    zoneButton.addEventListener("click", () => {
      overviewSelectedZone = zone;
      renderWarehouseOverview();
      requestAnimationFrame(() => {
        document.querySelector(`[data-overview-zone="${CSS.escape(zone)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    listHost.appendChild(zoneButton);
  });

  if (overviewTargetBatchId !== null) {
    const firstMatch = overviewLocations.find(
      (location) => Number(location.batch_id) === overviewTargetBatchId,
    );
    if (firstMatch && !overviewTargetAutoScrolled) {
      const batch = inventoryItems.find(
        (item) => Number(item.id) === overviewTargetBatchId,
      );
      document.getElementById("overviewLocationDetails").textContent =
        batch
          ? `${batch.name}（批次 ${batch.batch_no}）在此倉庫分布於 ${overviewLocations.filter((location) => Number(location.batch_id) === overviewTargetBatchId).map((location) => location.location_code).join("、")}`
          : `已標示 ${firstMatch.location_code}`;
      requestAnimationFrame(() => {
        zonesHost.querySelector(`[data-overview-zone="${CSS.escape(firstMatch.zone_code)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      overviewTargetAutoScrolled = true;
    }
  }
}

async function loadWarehouseOverview() {
  document.getElementById("overviewMapLoading").classList.remove("hidden");
  document.getElementById("overviewMapEmpty").classList.add("hidden");
  document.getElementById("overviewMapZones").replaceChildren();
  document.getElementById("overviewZoneList").replaceChildren();
  overviewLocations = await api(`/api/warehouses/${overviewWarehouseId}/map`);
  overviewSelectedZone = "";
  overviewSelectedLocationId = null;
  overviewTargetAutoScrolled = false;
  renderWarehouseOverview();
}

async function openWarehouseOverview(batchId = null) {
  const dialog = document.getElementById("warehouseOverviewModal");
  overviewTargetBatchId = batchId == null ? null : Number(batchId);
  overviewSelectedLocationId = null;
  overviewSelectedZone = "";
  overviewTargetAutoScrolled = false;
  document.getElementById("overviewLocationDetails").textContent =
    "滑過或點選地圖格位查看商品位置。";
  document.getElementById("overviewMapLoading").classList.remove("hidden");
  document.getElementById("overviewMapEmpty").classList.add("hidden");
  document.getElementById("overviewMapZones").replaceChildren();
  document.getElementById("overviewZoneList").replaceChildren();
  dialog.showModal();
  try {
    overviewWarehouses = await api("/api/warehouses");
    const select = document.getElementById("overviewWarehouseSelect");
    select.replaceChildren();
    overviewWarehouses.forEach((warehouse) =>
      select.add(new Option(warehouse.warehouse_name, warehouse.warehouse_id)),
    );
    overviewWarehouseId = String(overviewWarehouses[0]?.warehouse_id || "");
    if (!overviewWarehouseId) {
      overviewLocations = [];
      renderWarehouseOverview();
      return;
    }
    if (overviewTargetBatchId !== null) {
      const warehouseMaps = await Promise.all(
        overviewWarehouses.map((warehouse) =>
          api(`/api/warehouses/${warehouse.warehouse_id}/map`),
        ),
      );
      const matchingWarehouseIndex = warehouseMaps.findIndex((locations) =>
        locations.some(
          (location) => Number(location.batch_id) === overviewTargetBatchId,
        ),
      );
      if (matchingWarehouseIndex >= 0) {
        overviewWarehouseId = String(
          overviewWarehouses[matchingWarehouseIndex].warehouse_id,
        );
        overviewLocations = warehouseMaps[matchingWarehouseIndex];
        select.value = overviewWarehouseId;
        renderWarehouseOverview();
        return;
      }
    }
    select.value = overviewWarehouseId;
    await loadWarehouseOverview();
  } catch (error) {
    document.getElementById("overviewMapLoading").classList.add("hidden");
    document.getElementById("overviewMapEmpty").classList.remove("hidden");
    document.getElementById("overviewMapEmpty").textContent = error.message;
    document.getElementById("overviewZoneList").textContent = "無法載入倉庫區域。";
  }
}

function renderInventory() {
  updateSortIndicators();
  const tbody = document.getElementById("inventoryTableBody");
  const visible = getVisibleItems();
  tbody.replaceChildren();
  document.getElementById("resultsCount").textContent =
    `共顯示 ${visible.length} 筆批次`;
  document
    .getElementById("emptyState")
    .classList.toggle("hidden", visible.length !== 0);

  visible.forEach((item) => {
    const row = document.createElement("tr");
    row.className = "hover:bg-slate-50/80 transition text-slate-700";
    const nameCell = textCell(row, item.name);
    nameCell.classList.add("font-bold", "text-slate-800");
    const category = document.createElement("div");
    category.className = "text-xs text-slate-400";
    category.textContent = `${item.category || "未分類"} · ${item.batch_no || ""}`;
    nameCell.appendChild(category);
    textCell(row, item.origin || "未指定供應商");
    textCell(row, item.inboundDate);
    const receivedAt = textCell(
      row,
      item.receivedAt ? String(item.receivedAt).slice(0, 16) : "未記錄",
      "text-xs text-slate-600 tabular-nums",
    );
    receivedAt.title = "系統建立此進貨批次的時間";
    const expiry = textCell(row, item.expiryDate || "未設定");
    const days = daysRemaining(item.expiryDate);
    if (days !== null) {
      const suffix =
        days < 0
          ? `已過期 ${Math.abs(days)} 天`
          : days === 0
            ? "今天到期"
            : `剩 ${days} 天`;
      const note = document.createElement("div");
      note.className = "text-xs text-slate-500";
      note.textContent = suffix;
      expiry.appendChild(note);
    }
    const quantityCell = textCell(
      row,
      `${Number(item.qty).toLocaleString()} ${item.unit}`,
      "text-right font-bold text-slate-900",
    );
    if (Number(item.reservedQty) > 0) {
      const reserved = document.createElement("div");
      reserved.className = "mt-0.5 text-xs font-normal text-amber-700";
      reserved.textContent = `待揀貨預留 ${Number(item.reservedQty).toLocaleString()} ${item.unit}`;
      quantityCell.appendChild(reserved);
    }
    if (item.input_quantity != null && item.input_unit && item.input_unit !== item.unit) {
      const inputDetail = document.createElement("div");
      inputDetail.className = "mt-0.5 text-xs font-normal text-slate-500";
      inputDetail.textContent = `進貨 ${Number(item.input_quantity).toLocaleString()} ${item.input_unit}`;
      quantityCell.appendChild(inputDetail);
    }
    textCell(
      row,
      `${Number(item.unitCostPerKg || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元/kg`,
      "text-right tabular-nums",
    );
    const statusCell = textCell(row, "");
    statusCell.classList.add("text-center");
    const badge = document.createElement("span");
    const isExpired = days !== null && days < 0;
    const isExpiring = days !== null && days <= 3;
    badge.className = `font-semibold px-2.5 py-1 rounded-full text-xs ${isExpired ? "bg-rose-100 text-rose-700" : isExpiring ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`;
    badge.textContent =
      days === null
        ? "未設定效期"
        : isExpired
          ? "已過期"
          : isExpiring
            ? "即將到期"
            : "新鮮";
    statusCell.appendChild(badge);
    const actions = textCell(row, "");
    actions.classList.add("text-center");
    const group = document.createElement("div");
    group.className = "flex items-center justify-center gap-1.5";
    [
      ["map", "位置", "bg-blue-50 text-blue-700 hover:bg-blue-100"],
      ["scrap", "報廢", "bg-rose-50 text-rose-700 hover:bg-rose-100"],
    ].forEach(([type, label, style]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `px-2.5 py-1 rounded text-xs font-medium transition ${style}`;
      button.textContent = label;
      if (type === "map") button.title = `查看 ${item.name} 的倉儲位置`;
      button.addEventListener("click", () => {
        if (type === "map") openWarehouseOverview(item.id);
        else openActionModal(String(item.id), type);
      });
      group.appendChild(button);
    });
    actions.appendChild(group);
    tbody.appendChild(row);
  });
  updateMetrics();
}

function updateMetrics() {
  const expiring = inventoryItems.filter((item) => {
    const days = daysRemaining(item.expiryDate);
    return days !== null && days >= 0 && days <= 3;
  }).length;
  const expired = inventoryItems.filter((item) => {
    const days = daysRemaining(item.expiryDate);
    return days !== null && days < 0;
  }).length;
  document.getElementById("statTotalItems").innerHTML =
    `${new Set(inventoryItems.map((item) => item.product_id)).size} <span class="text-xs font-normal text-slate-500">項</span>`;
  document.getElementById("statExpiringCount").innerHTML =
    `${expiring} <span class="text-xs font-normal text-slate-500">批</span>`;
  document.getElementById("statExpiredCount").innerHTML =
    `${expired} <span class="text-xs font-normal text-slate-500">批</span>`;
  const totalQtyCard = document.getElementById("statTotalQty");
  const kgItems = inventoryItems.filter((item) => ["kg", "公斤"].includes(String(item.unit || "").trim().toLowerCase()));
  const legacyItems = inventoryItems.filter((item) => !["kg", "公斤"].includes(String(item.unit || "").trim().toLowerCase()));
  const totalKg = kgItems.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  totalQtyCard.replaceChildren();
  const totalLabel = document.createElement("span");
  totalLabel.textContent = `${totalKg.toLocaleString(undefined, { maximumFractionDigits: 2 })} `;
  const unitLabel = document.createElement("span");
  unitLabel.className = "text-xs font-normal text-slate-500";
  unitLabel.textContent = "kg";
  totalQtyCard.append(totalLabel, unitLabel);
  if (legacyItems.length) {
    const legacyNote = document.createElement("div");
    legacyNote.className = "mt-1 text-xs font-normal leading-4 text-amber-700";
    legacyNote.textContent = `另有 ${legacyItems.length} 批非公斤庫存未納入`;
    totalQtyCard.appendChild(legacyNote);
  }
  const box = document.getElementById("urgentAlertBox");
  const count = expiring + expired;
  document.getElementById("urgentBadgeCount").textContent =
    `${count} 批需要注意`;
  document.getElementById("urgentAlertText").textContent =
    `目前有 ${expiring} 批即將到期、${expired} 批已過期，請優先處理。`;
  box.classList.toggle("hidden", count === 0);
}

function selectCategory(category) {
  selectedCategory = category;
  document.querySelectorAll(".category-btn").forEach((button) => {
    const active = button.dataset.cat === category;
    button.classList.toggle("bg-emerald-600", active);
    button.classList.toggle("text-white", active);
    button.classList.toggle("bg-slate-100", !active);
    button.classList.toggle("text-slate-700", !active);
  });
  renderInventory();
}

function filterStatus(status) {
  document.getElementById("statusSelect").value = status;
  renderInventory();
}

function applyFilters() {
  renderInventory();
}

document.querySelectorAll("[data-sort-key]").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.sortKey;
    if (sortState.key === key) sortState.direction *= -1;
    else sortState = { key, direction: 1 };
    renderInventory();
  });
});

document.getElementById("openWarehouseOverview").addEventListener("click", () => {
  openWarehouseOverview();
});
document.getElementById("closeWarehouseOverview").addEventListener("click", () => {
  document.getElementById("warehouseOverviewModal").close();
});
document.getElementById("overviewWarehouseSelect").addEventListener("change", async (event) => {
  overviewWarehouseId = event.target.value;
  overviewSelectedLocationId = null;
  overviewSelectedZone = "";
  overviewTargetAutoScrolled = false;
  document.getElementById("overviewLocationDetails").textContent =
    "滑過或點選地圖格位查看商品位置。";
  try {
    await loadWarehouseOverview();
  } catch (error) {
    document.getElementById("overviewMapLoading").classList.add("hidden");
    document.getElementById("overviewMapEmpty").classList.remove("hidden");
    document.getElementById("overviewMapEmpty").textContent = error.message;
  }
});
document.getElementById("warehouseOverviewModal").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.getElementById("warehouseOverviewModal").addEventListener("close", () => {
  document.getElementById("overviewMapTooltip").classList.add("hidden");
});

function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  document.getElementById("toastMessage").textContent = message;
  document.getElementById("toastIcon").className =
    type === "error"
      ? "fa-solid fa-circle-exclamation text-rose-400 text-lg"
      : "fa-solid fa-circle-check text-emerald-400 text-lg";
  toast.classList.remove("translate-y-20", "opacity-0");
  setTimeout(() => toast.classList.add("translate-y-20", "opacity-0"), 3000);
}

async function refreshInventory() {
  inventoryItems = await api("/api/inventory");
  renderInventory();
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  modal.classList.remove("hidden");
  setTimeout(() => {
    modal.classList.remove("opacity-0");
    modal.children[0].classList.remove("scale-95");
    modal.children[0].classList.add("scale-100");
  }, 10);
  if (modalId === "addModal") {
    document.getElementById("addInboundDate").value = localDateOffset(0);
    document.getElementById("addExpiryDate").value = localDateOffset(5);
    loadProductUnitConversion();
  }
}

function updateReceiptTotal() {
  const quantity = Number(document.getElementById("addInputQuantity").value) || 0;
  const factor = Number(document.getElementById("addKgPerUnit").value) || 0;
  document.getElementById("addTotalKg").textContent = (quantity * factor).toFixed(2);
}

async function loadProductUnitConversion() {
  const name = document.getElementById("addName").value.trim();
  const unit = document.getElementById("addInputUnit").value;
  const factorField = document.getElementById("addKgPerUnit");
  const sourceField = document.getElementById("addConversionSource");
  const noteField = document.getElementById("addConversionNote");
  if (unit === "kg") {
    factorField.value = "1";
    sourceField.value = "PUBLIC_STANDARD";
    noteField.value = "公斤基準單位，1 kg = 1 kg";
    factorField.disabled = true;
    sourceField.disabled = true;
    noteField.disabled = true;
    updateReceiptTotal();
    return;
  }
  factorField.disabled = false;
  sourceField.disabled = false;
  noteField.disabled = false;
  if (noteField.value === "公斤基準單位，1 kg = 1 kg") {
    sourceField.value = "SIMULATION_ASSUMPTION";
    noteField.value = "模擬作業假設，請填寫此商品的換算依據";
  }
  factorField.value = "";
  factorField.placeholder = "首次設定請輸入公斤換算值";
  if (!name) {
    updateReceiptTotal();
    return;
  }
  try {
    const query = new URLSearchParams({ name, unit });
    const saved = await api(`/api/products/unit-conversion?${query}`);
    if (saved.productFound && saved.baseUnit !== "kg") {
      showToast(`此商品舊庫存使用 ${saved.baseUnit}，需先確認並轉換舊資料。`, "error");
    } else if (saved.kgPerUnit != null) {
      factorField.value = saved.kgPerUnit;
      factorField.disabled = true;
      sourceField.value = saved.source || "SIMULATION_ASSUMPTION";
      noteField.value = saved.note || "已儲存的商品單位換算";
      sourceField.disabled = true;
      noteField.disabled = true;
    }
  } catch (error) {
    showToast(error.message, "error");
  }
  updateReceiptTotal();
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  modal.children[0].classList.remove("scale-100");
  modal.children[0].classList.add("scale-95");
  modal.classList.add("opacity-0");
  setTimeout(() => modal.classList.add("hidden"), 200);
}

async function handleAddSubmit(event) {
  event.preventDefault();
  const form = document.getElementById("addForm");
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const data = await api("/api/receipts", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("addName").value.trim(),
        category: document.getElementById("addCategory").value,
        origin: document.getElementById("addOrigin").value.trim(),
        inboundDate: document.getElementById("addInboundDate").value,
        expiryDate: document.getElementById("addExpiryDate").value,
        inputQuantity: document.getElementById("addInputQuantity").value,
        inputUnit: document.getElementById("addInputUnit").value,
        kgPerUnit: document.getElementById("addKgPerUnit").value,
        conversionSource: document.getElementById("addConversionSource").value,
        conversionNote: document.getElementById("addConversionNote").value.trim(),
        unitCostPerKg: document.getElementById("addUnitCost").value,
      }),
    });
    closeModal("addModal");
    form.reset();
    loadProductUnitConversion();
    await refreshInventory();
    showToast(`進貨已儲存（單號 ${data.purchaseNo}）`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("input", (event) => {
  if (["addInputQuantity", "addKgPerUnit"].includes(event.target.id))
    updateReceiptTotal();
});
document.getElementById("addInputUnit").addEventListener("change", loadProductUnitConversion);
document.getElementById("addName").addEventListener("blur", loadProductUnitConversion);

function openActionModal(id, type) {
  const picker = document.getElementById("outboundProductPicker");
  const productSelect = document.getElementById("outboundProductSelect");
  const item = id == null
    ? null
    : inventoryItems.find((entry) => String(entry.id) === String(id));
  if (id != null && !item) return;
  if (type === "deduct" && id == null) {
    const availableItems = inventoryItems.filter((entry) => Number(entry.qty) > 0);
    if (!availableItems.length) {
      showToast("目前沒有可出貨的庫存批次。", "error");
      return;
    }
    const products = [...new Map(availableItems.map((entry) => [Number(entry.product_id), entry])).values()]
      .sort((a, b) => chineseStrokeCollator.compare(a.name || "", b.name || ""));
    productSelect.replaceChildren();
    products.forEach((product) => productSelect.add(new Option(product.name, product.product_id)));
    document.getElementById("outboundBatchList").replaceChildren();
    picker.classList.remove("hidden");
    document.getElementById("actionItemId").value = "";
    document.getElementById("actionQtyInput").disabled = true;
    document.getElementById("actionNoteInput").disabled = true;
    document.getElementById("actionSubmitBtn").disabled = true;
    document.getElementById("actionItemName").textContent = "請先選擇產品庫存批次";
    document.getElementById("actionItemCaption").textContent = "目前可出貨庫存：";
    document.getElementById("actionCurrentQty").textContent = "選取產品後，點選要出貨的倉庫位置與批次。";
    document.getElementById("actionQtyInput").value = "";
    document.getElementById("actionNoteInput").value = "";
    document.getElementById("actionType").value = type;
    document.getElementById("outboundConfirmWrap").classList.remove("hidden");
    document.getElementById("outboundConfirmCheck").checked = false;
    document.getElementById("outboundConfirmCheck").disabled = true;
    document.getElementById("actionModalTitle").textContent = "蔬果銷售 / 出庫登記";
    document.getElementById("actionSubmitBtn").textContent = "建立出貨單並預留庫存";
    document.getElementById("actionQtyLabel").textContent = "出貨數量";
    openModal("actionModal");
    renderOutboundBatches(productSelect.value).catch((error) => showToast(error.message, "error"));
    return;
  } else {
    picker.classList.add("hidden");
    document.getElementById("outboundConfirmWrap").classList.add("hidden");
    document.getElementById("outboundConfirmCheck").checked = false;
    document.getElementById("outboundConfirmCheck").disabled = true;
  }
  document.getElementById("actionQtyInput").disabled = false;
  document.getElementById("actionNoteInput").disabled = false;
  document.getElementById("actionSubmitBtn").disabled = false;
  const selectedItem = item;
  if (!selectedItem) return;
  document.getElementById("actionItemId").value = selectedItem.id;
  document.getElementById("actionType").value = type;
  updateActionStockSummary(selectedItem, type);
  document.getElementById("actionQtyInput").value = "";
  document.getElementById("actionQtyInput").max = selectedItem.qty;
  document.getElementById("actionNoteInput").value = "";
  document.getElementById("actionModalTitle").textContent =
    type === "deduct" ? "蔬果銷售 / 出庫登記" : "蔬果損耗 / 報廢登記";
  document.getElementById("actionSubmitBtn").textContent =
    type === "deduct" ? "建立出貨單並預留庫存" : "確認報廢";
  document.getElementById("actionQtyLabel").textContent = `${type === "deduct" ? "出貨" : "報廢"}數量 (${selectedItem.unit})`;
  openModal("actionModal");
}

async function renderOutboundBatches(productId) {
  const list = document.getElementById("outboundBatchList");
  const batches = inventoryItems
    .filter((entry) => Number(entry.product_id) === Number(productId) && Number(entry.qty) > 0)
    .sort((a, b) =>
      String(a.inboundDate || "9999-12-31").localeCompare(String(b.inboundDate || "9999-12-31")) ||
      String(a.receivedAt || "9999-12-31 23:59:59").localeCompare(String(b.receivedAt || "9999-12-31 23:59:59")) ||
      Number(a.id) - Number(b.id),
    );
  list.replaceChildren();
  if (!batches.length) {
    list.textContent = "此產品目前沒有可出貨庫存。";
    return;
  }
  list.textContent = "正在載入倉儲位置…";
  const locationResults = await Promise.all(
    batches.map((batch) => api(`/api/batches/${encodeURIComponent(batch.id)}/locations`)),
  );
  list.replaceChildren();
  batches.forEach((batch, index) => {
    const locations = locationResults[index];
    const locatedQuantity = locations.reduce((sum, location) => sum + Number(location.quantity || 0), 0);
    const unlocatedQuantity = Math.max(0, Number(batch.qty) - locatedQuantity);
    const locationText = locations.map((location) =>
      `${location.warehouse_name} · ${location.zone_code}區 · ${location.location_code}（${Number(location.quantity).toLocaleString()} ${batch.unit}）`,
    );
    if (unlocatedQuantity > 0.000001)
      locationText.push(`尚未上架（${unlocatedQuantity.toLocaleString()} ${batch.unit}）`);

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.outboundBatchId = batch.id;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    button.className = "w-full rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-emerald-400 hover:bg-emerald-50";
    const title = document.createElement("span");
    title.className = "block text-sm font-bold text-slate-800";
    title.textContent = `${index === 0 ? "FIFO 優先 · " : ""}批次 ${batch.batch_no} · 可用 ${Number(batch.qty).toLocaleString()} ${batch.unit}`;
    const detail = document.createElement("span");
    detail.className = "mt-1 block text-xs text-slate-600";
    detail.textContent = `進貨 ${batch.inboundDate || "未記錄"} · 效期 ${batch.expiryDate || "未設定"}`;
    const location = document.createElement("span");
    location.className = "mt-1 block text-xs leading-5 text-slate-500";
    location.textContent = locationText.length ? locationText.join("；") : "尚無倉儲格位資訊";
    button.append(title, detail, location);
    button.addEventListener("click", () => {
      if (index > 0 && document.getElementById("actionItemId").value !== String(batch.id)) {
        const earliestBatch = batches[0];
        const confirmed = window.confirm(
          `仍有較早進貨的批次 ${earliestBatch.batch_no}（${Number(earliestBatch.qty).toLocaleString()} ${earliestBatch.unit}）尚未出完。\n\n要確認跳過較早批次，改選批次 ${batch.batch_no} 嗎？`,
        );
        if (!confirmed) return;
      }
      list.querySelectorAll("[data-outbound-batch-id]").forEach((option) => {
        option.classList.remove("border-emerald-500", "bg-emerald-50", "ring-1", "ring-emerald-400");
        option.setAttribute("aria-selected", "false");
      });
      button.classList.add("border-emerald-500", "bg-emerald-50", "ring-1", "ring-emerald-400");
      button.setAttribute("aria-selected", "true");
      selectOutboundBatch(batch);
    });
    list.appendChild(button);
  });
  const fifoButton = list.querySelector("[data-outbound-batch-id]");
  if (fifoButton) {
    fifoButton.classList.add("border-emerald-500", "bg-emerald-50", "ring-1", "ring-emerald-400");
    fifoButton.setAttribute("aria-selected", "true");
    selectOutboundBatch(batches[0]);
  }
}

function selectOutboundBatch(selectedItem) {
  document.getElementById("actionItemId").value = selectedItem.id;
  document.getElementById("actionQtyInput").disabled = false;
  document.getElementById("actionNoteInput").disabled = false;
  document.getElementById("actionSubmitBtn").disabled = true;
  document.getElementById("outboundConfirmCheck").checked = false;
  document.getElementById("outboundConfirmCheck").disabled = false;
  document.getElementById("actionQtyInput").value = "";
  document.getElementById("actionQtyInput").max = selectedItem.qty;
  document.getElementById("actionQtyLabel").textContent = `出貨數量 (${selectedItem.unit})`;
  updateActionStockSummary(selectedItem, "deduct");
}

function updateActionStockSummary(selectedItem, type) {
  const caption = document.getElementById("actionItemCaption");
  const quantity = document.getElementById("actionCurrentQty");
  document.getElementById("actionItemName").textContent = selectedItem.name;
  if (type === "deduct") {
    const productAvailable = inventoryItems
      .filter((entry) => Number(entry.product_id) === Number(selectedItem.product_id))
      .reduce((sum, entry) => sum + Number(entry.qty || 0), 0);
    caption.textContent = "目前可出貨庫存：";
    quantity.textContent = `商品可出貨總量 ${productAvailable.toLocaleString()} ${selectedItem.unit} · 本次批次 ${Number(selectedItem.qty).toLocaleString()} ${selectedItem.unit} · 效期 ${selectedItem.expiryDate || "未設定"}`;
  } else {
    caption.textContent = "當前品項：";
    quantity.textContent = `目前批次庫存：${Number(selectedItem.qty).toLocaleString()} ${selectedItem.unit}`;
  }
}

document.getElementById("outboundProductSelect").addEventListener("change", (event) => {
  document.getElementById("actionItemId").value = "";
  document.getElementById("actionQtyInput").disabled = true;
  document.getElementById("actionNoteInput").disabled = true;
  document.getElementById("actionSubmitBtn").disabled = true;
  document.getElementById("actionQtyInput").value = "";
  document.getElementById("actionNoteInput").value = "";
  document.getElementById("outboundConfirmCheck").checked = false;
  document.getElementById("outboundConfirmCheck").disabled = true;
  document.getElementById("actionItemName").textContent = "請選擇下方的庫存批次";
  document.getElementById("actionCurrentQty").textContent = "點選批次可查看該批存放的倉庫與格位。";
  renderOutboundBatches(event.target.value).catch((error) => showToast(error.message, "error"));
});

document.getElementById("outboundConfirmCheck").addEventListener("change", (event) => {
  document.getElementById("actionSubmitBtn").disabled = !event.target.checked;
});

document.getElementById("actionQtyInput").addEventListener("input", () => {
  if (document.getElementById("actionType").value !== "deduct") return;
  document.getElementById("outboundConfirmCheck").checked = false;
  document.getElementById("actionSubmitBtn").disabled = true;
});

async function handleActionSubmit(event) {
  event.preventDefault();
  const button = document.getElementById("actionSubmitBtn");
  button.disabled = true;
  try {
    const isOutbound = document.getElementById("actionType").value === "deduct";
    if (isOutbound && !document.getElementById("outboundConfirmCheck").checked) {
      showToast("請先核對產品、批次、儲位和出貨數量。", "error");
      return;
    }
    if (isOutbound) {
      const item = inventoryItems.find(
        (entry) => String(entry.id) === document.getElementById("actionItemId").value,
      );
      const quantity = document.getElementById("actionQtyInput").value;
      const locationSummary = document.getElementById("actionCurrentQty").textContent;
      const confirmed = window.confirm(
        `即將建立 ${item?.name || "所選商品"}（批次 ${item?.batch_no || ""}）出貨單，數量 ${quantity} ${item?.unit || ""}。\n${locationSummary}\n\n建立後請依單據到倉位取貨，再到「出貨單」確認揀貨完成；確認前不會扣減庫存。`,
      );
      if (!confirmed) return;
    }
    const payload = {
      quantity: document.getElementById("actionQtyInput").value,
      remark: document.getElementById("actionNoteInput").value.trim(),
    };
    if (isOutbound) {
      const result = await api("/api/outbound-orders", {
        method: "POST",
        body: JSON.stringify({ ...payload, batchId: document.getElementById("actionItemId").value }),
      });
      closeModal("actionModal");
      window.location.href = `/shipments.html?created=${encodeURIComponent(result.outboundNo)}`;
      return;
    }
    await api(`/api/batches/${encodeURIComponent(document.getElementById("actionItemId").value)}/issues`, {
      method: "POST",
      body: JSON.stringify({ ...payload, type: document.getElementById("actionType").value }),
    });
    closeModal("actionModal");
    await refreshInventory();
    showToast("庫存異動已儲存");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled =
      document.getElementById("actionType").value === "deduct"
        ? !document.getElementById("outboundConfirmCheck").checked
        : false;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    await refreshInventory();
  } catch (error) {
    showToast(error.message, "error");
    document.getElementById("emptyState").classList.remove("hidden");
    document.querySelector("#emptyState h3").textContent = "資料庫目前無法連線";
    document.querySelector("#emptyState p").textContent =
      "請確認已啟動 API 伺服器並設定 MySQL 連線。";
  }
});
