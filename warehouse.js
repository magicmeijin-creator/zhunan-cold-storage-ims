let locations = [];
let activeWarehouseId = "";
let activeZoneCode = "";
let sourceLocation = null;

async function warehouseApi(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "操作失敗，請稍後再試。");
  return data;
}

function notify(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.add("hidden"), 3500);
}

function closeDialog(id) {
  document.getElementById(id).close();
}

async function loadWarehouses(preferredId) {
  const warehouses = await warehouseApi("/api/warehouses");
  const select = document.getElementById("warehouseSelect");
  select.replaceChildren();
  if (!warehouses.length) {
    const option = new Option("尚未建立倉庫", "");
    select.add(option);
    activeWarehouseId = "";
    locations = [];
    document.getElementById("renameWarehouseName").value = "";
    document.getElementById("renameWarehouseButton").disabled = true;
    renderMap();
    return;
  }
  warehouses.forEach((warehouse) =>
    select.add(new Option(warehouse.warehouse_name, warehouse.warehouse_id)),
  );
  activeWarehouseId = String(
    preferredId || select.value || warehouses[0].warehouse_id,
  );
  select.value = activeWarehouseId;
  const selectedWarehouse = warehouses.find(
    (warehouse) => String(warehouse.warehouse_id) === activeWarehouseId,
  );
  document.getElementById("renameWarehouseName").value =
    selectedWarehouse?.warehouse_name || "";
  document.getElementById("renameWarehouseButton").disabled = !selectedWarehouse;
  await loadMap();
}

async function loadMap() {
  if (!activeWarehouseId) return;
  locations = await warehouseApi(`/api/warehouses/${activeWarehouseId}/map`);
  sourceLocation = null;
  const zones = [...new Set(locations.map((location) => location.zone_code))];
  if (!zones.includes(activeZoneCode)) activeZoneCode = zones[0] || "";
  renderMap();
}

function renderMap() {
  const grid = document.getElementById("mapGrid");
  const empty = document.getElementById("mapEmpty");
  const carousel = document.getElementById("zoneCarousel");
  grid.replaceChildren();
  if (!locations.length) {
    document.getElementById("mapTitle").textContent = activeWarehouseId
      ? "此倉庫目前沒有格位"
      : "請先建立倉庫格位";
    document.getElementById("mapSummary").textContent = "";
    carousel.classList.add("hidden");
    empty.classList.toggle("hidden", !activeWarehouseId);
    return;
  }
  empty.classList.add("hidden");
  const zones = [...new Set(locations.map((location) => location.zone_code))];
  if (!zones.includes(activeZoneCode)) activeZoneCode = zones[0];
  const zone = activeZoneCode;
  const area = locations.filter((location) => location.zone_code === zone);
  const maxColumn = Math.max(
    ...area.map((location) => Number(location.column_no)),
  );
  const occupied = area.filter((location) => location.batch_id != null).length;
  document.getElementById("mapTitle").textContent = `區域 ${zone} 倉儲格位圖`;
  document.getElementById("mapSummary").textContent =
    `${area.length} 格 · ${occupied} 格有庫存 · ${area.length - occupied} 格空置`;
  renderZoneCarousel(zones);
  grid.className = "overflow-x-auto";
  const board = document.createElement("div");
  board.className = "map-grid min-w-max";
  board.style.setProperty("--columns", maxColumn);
  area.forEach((location) => {
    const button = document.createElement("button");
    button.type = "button";
    const isOccupied = location.batch_id != null;
    const days = location.expiry_date ? dateDays(location.expiry_date) : null;
    const expiring = isOccupied && days !== null && days <= 3;
    const selected =
      sourceLocation &&
      Number(sourceLocation.location_id) === Number(location.location_id);
    button.className = `slot w-full rounded-xl border p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow ${selected ? "ring-2 ring-blue-500" : ""} ${!isOccupied ? "border-slate-200 bg-white hover:border-emerald-400" : expiring ? "border-amber-300 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`;
    const code = document.createElement("span");
    code.className = "block text-xs font-bold text-slate-500";
    code.textContent = location.location_code;
    button.appendChild(code);
    const name = document.createElement("span");
    name.className = "mt-2 block text-sm font-bold text-slate-800";
    name.textContent = isOccupied ? location.product_name : "空格位";
    button.appendChild(name);
    if (isOccupied) {
      const detail = document.createElement("span");
      detail.className = "mt-1 block text-xs leading-5 text-slate-600";
      detail.textContent = `${Number(location.stored_quantity).toLocaleString()} ${location.unit} · ${location.batch_no}`;
      button.appendChild(detail);
      const storedAt = document.createElement("span");
      storedAt.className = "mt-1 block text-xs text-slate-500";
      storedAt.textContent = location.storedAt
        ? `存入時間 ${String(location.storedAt).slice(0, 16)}`
        : "存入時間未記錄";
      button.appendChild(storedAt);
      const expiry = document.createElement("span");
      expiry.className = `mt-1 block text-xs ${expiring ? "font-semibold text-amber-800" : "text-slate-500"}`;
      expiry.textContent = location.expiry_date
        ? `效期 ${String(location.expiry_date).slice(0, 10)}`
        : "未設定效期";
      button.appendChild(expiry);
    } else {
      const hint = document.createElement("span");
      hint.className = "mt-1 block text-xs text-emerald-700";
      hint.textContent = sourceLocation ? "點此移庫到這格" : "點此上架";
      button.appendChild(hint);
    }
    button.addEventListener("click", () => handleSlotClick(location));
    board.appendChild(button);
  });
  grid.appendChild(board);
}

function renderZoneCarousel(zones) {
  const carousel = document.getElementById("zoneCarousel");
  const indicators = document.getElementById("zoneIndicators");
  const activeIndex = zones.indexOf(activeZoneCode);
  carousel.classList.toggle("hidden", zones.length <= 1);
  document.getElementById("activeZoneLabel").textContent =
    `區域 ${activeZoneCode}　${activeIndex + 1} / ${zones.length}`;
  const previous = document.getElementById("previousZone");
  const next = document.getElementById("nextZone");
  previous.disabled = activeIndex <= 0;
  next.disabled = activeIndex >= zones.length - 1;
  previous.classList.toggle("opacity-40", previous.disabled);
  next.classList.toggle("opacity-40", next.disabled);
  indicators.replaceChildren();
  zones.forEach((zone) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `rounded-full px-3 py-1 text-xs font-medium ${zone === activeZoneCode ? "bg-emerald-700 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`;
    button.textContent = `區域 ${zone}`;
    button.setAttribute("aria-pressed", String(zone === activeZoneCode));
    button.addEventListener("click", () => setActiveZone(zone));
    indicators.appendChild(button);
  });
}

function setActiveZone(zone) {
  activeZoneCode = zone;
  sourceLocation = null;
  renderMap();
}

function stepZone(direction) {
  const zones = [...new Set(locations.map((location) => location.zone_code))];
  const nextIndex = zones.indexOf(activeZoneCode) + direction;
  if (nextIndex >= 0 && nextIndex < zones.length) setActiveZone(zones[nextIndex]);
}

function dateDays(value) {
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  const today = new Date();
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.UTC(year, month - 1, day) - now) / 86400000);
}

async function handleSlotClick(location) {
  if (location.batch_id != null) {
    if (
      sourceLocation &&
      Number(sourceLocation.location_id) === Number(location.location_id)
    ) {
      sourceLocation = null;
    } else {
      sourceLocation = location;
      notify(`已選擇來源格位 ${location.location_code}，再點一個空格位移庫。`);
    }
    renderMap();
    return;
  }
  if (sourceLocation) return moveStock(location);
  return openPutaway(location);
}

async function openPutaway(location) {
  try {
    const batches = await warehouseApi(
      `/api/warehouses/${activeWarehouseId}/unlocated-batches`,
    );
    const select = document.getElementById("batchSelect");
    select.replaceChildren();
    if (!batches.length) {
      notify("目前沒有尚未上架的庫存批次。請先在進銷存總覽登記進貨。");
      return;
    }
    batches.forEach((batch) => {
      const label = `${batch.product_name} · ${batch.batch_no} · 可上架 ${Number(batch.unlocated_quantity)} ${batch.unit}`;
      select.add(new Option(label, batch.batch_id));
    });
    const selected = batches[0];
    document.getElementById("putawayLocation").textContent =
      `目的格位：${location.location_code}`;
    document.getElementById("putawayQuantity").max =
      selected.unlocated_quantity;
    document.getElementById("putawayQuantity").value =
      selected.unlocated_quantity;
    select.onchange = () => {
      const batch = batches.find(
        (item) => String(item.batch_id) === select.value,
      );
      document.getElementById("putawayQuantity").max = batch.unlocated_quantity;
      document.getElementById("putawayQuantity").value =
        batch.unlocated_quantity;
    };
    document.getElementById("putawayForm").dataset.locationId =
      location.location_id;
    document.getElementById("putawayDialog").showModal();
  } catch (error) {
    notify(error.message);
  }
}

async function moveStock(destination) {
  const source = sourceLocation;
  const quantity = Number(
    window.prompt(
      `從 ${source.location_code} 移至 ${destination.location_code}。可移動 ${source.stored_quantity} ${source.unit}，請輸入數量：`,
      source.stored_quantity,
    ),
  );
  if (!Number.isFinite(quantity) || quantity <= 0) return;
  try {
    await warehouseApi(`/api/locations/${source.location_id}/move`, {
      method: "POST",
      body: JSON.stringify({
        destinationLocationId: destination.location_id,
        quantity,
      }),
    });
    sourceLocation = null;
    await loadMap();
    notify("移庫完成，異動紀錄已儲存。");
  } catch (error) {
    notify(error.message);
  }
}

document
  .getElementById("warehouseSelect")
  .addEventListener("change", async (event) => {
    activeWarehouseId = event.target.value;
    document.getElementById("renameWarehouseName").value =
      event.target.selectedOptions[0]?.textContent || "";
    document.getElementById("renameWarehouseButton").disabled =
      !activeWarehouseId;
    try {
      await loadMap();
    } catch (error) {
      notify(error.message);
    }
  });

document
  .getElementById("renameWarehouseForm")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeWarehouseId) return notify("請先選擇倉庫。");
    const button = document.getElementById("renameWarehouseButton");
    button.disabled = true;
    try {
      const data = await warehouseApi(`/api/warehouses/${activeWarehouseId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: document.getElementById("renameWarehouseName").value.trim(),
        }),
      });
      const option = document.querySelector(
        `#warehouseSelect option[value="${activeWarehouseId}"]`,
      );
      if (option) option.textContent = data.name;
      document.getElementById("renameWarehouseName").value = data.name;
      notify(`倉庫已重新命名為「${data.name}」。`);
    } catch (error) {
      notify(error.message);
    } finally {
      button.disabled = false;
    }
  });

document
  .getElementById("previousZone")
  .addEventListener("click", () => stepZone(-1));
document
  .getElementById("nextZone")
  .addEventListener("click", () => stepZone(1));

document
  .getElementById("createWarehouseForm")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await warehouseApi("/api/warehouses", {
        method: "POST",
        body: JSON.stringify({
          name: document.getElementById("warehouseName").value.trim(),
          zoneCode: document.getElementById("zoneCode").value.trim(),
          rows: document.getElementById("rowCount").value,
          columns: document.getElementById("columnCount").value,
        }),
      });
      event.target.reset();
      document.getElementById("zoneCode").value = "A";
      await loadWarehouses(data.warehouseId);
      notify(`已建立 ${data.rows * data.columns} 個格位。`);
    } catch (error) {
      notify(error.message);
    }
  });

document
  .getElementById("createZoneForm")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeWarehouseId) return notify("請先建立或選擇倉庫。");
    try {
      const data = await warehouseApi(
        `/api/warehouses/${activeWarehouseId}/zones`,
        {
          method: "POST",
          body: JSON.stringify({
            zoneCode: document.getElementById("newZoneCode").value.trim(),
            rows: document.getElementById("newZoneRows").value,
            columns: document.getElementById("newZoneColumns").value,
          }),
        },
      );
      event.target.reset();
      await loadMap();
      setActiveZone(data.zoneCode);
      notify(
        `已新增區域 ${data.zoneCode}，共 ${data.rows * data.columns} 格。`,
      );
    } catch (error) {
      notify(error.message);
    }
  });

document
  .getElementById("putawayForm")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await warehouseApi(`/api/locations/${form.dataset.locationId}/putaway`, {
        method: "POST",
        body: JSON.stringify({
          batchId: document.getElementById("batchSelect").value,
          quantity: document.getElementById("putawayQuantity").value,
        }),
      });
      closeDialog("putawayDialog");
      await loadMap();
      notify("上架完成，異動紀錄已儲存。");
    } catch (error) {
      notify(error.message);
    }
  });

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadWarehouses();
  } catch (error) {
    notify(error.message);
  }
});
