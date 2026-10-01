const ordersList = document.getElementById("ordersList");
const statusFilter = document.getElementById("statusFilter");
const toast = document.getElementById("toast");
let toastTimer;

function escapeText(value) {
  return String(value ?? "");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "系統暫時無法完成操作。");
  return data;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = `fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-3 text-sm text-white shadow-lg ${isError ? "bg-rose-700" : "bg-slate-900"}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function formatDate(value) {
  if (!value) return "—";
  return String(value).replace("T", " ").slice(0, 16);
}

function statusStyle(status) {
  if (status === "WAITING_PICK") return ["待揀貨", "bg-amber-100 text-amber-800"];
  if (status === "COMPLETED") return ["已完成", "bg-emerald-100 text-emerald-800"];
  return ["已取消", "bg-slate-100 text-slate-600"];
}

function makeText(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = escapeText(value);
  return element;
}

function renderOrder(order) {
  const article = document.createElement("article");
  article.className = "p-4 sm:p-5";
  const header = document.createElement("div");
  header.className = "flex flex-wrap items-start justify-between gap-3";
  const heading = document.createElement("div");
  heading.append(
    makeText("h3", "font-bold text-slate-900", `${order.outbound_no} · ${order.product_name}`),
    makeText("p", "mt-1 text-xs text-slate-500", `建立時間 ${formatDate(order.created_at)} · 批次 ${order.batch_no}`),
  );
  const [label, style] = statusStyle(order.status);
  const badge = makeText("span", `rounded-full px-3 py-1 text-xs font-semibold ${style}`, label);
  header.append(heading, badge);

  const detail = document.createElement("div");
  detail.className = "mt-4 grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center";
  const locationBlock = document.createElement("div");
  locationBlock.append(makeText("p", "text-xs font-semibold text-slate-500", "指定取貨位置"));
  locationBlock.append(makeText("p", "mt-1 text-sm leading-6 text-slate-800", order.pick_locations || "沒有格位分配資料"));
  const quantity = makeText("p", "whitespace-nowrap text-lg font-bold text-slate-900 sm:text-right", `${Number(order.quantity).toLocaleString()} ${order.unit}`);
  detail.append(locationBlock, quantity);
  article.append(header, detail);

  if (order.remark) article.append(makeText("p", "mt-3 text-sm text-slate-600", `備註：${order.remark}`));
  if (order.status === "WAITING_PICK") {
    const actions = document.createElement("div");
    actions.className = "mt-4 flex flex-wrap justify-end gap-2";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50";
    cancel.textContent = "取消出貨單";
    cancel.addEventListener("click", () => updateOrder(order, "cancel"));
    const complete = document.createElement("button");
    complete.type = "button";
    complete.className = "rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800";
    complete.innerHTML = '<i class="fa-solid fa-check mr-1"></i>確認揀貨完成';
    complete.addEventListener("click", () => updateOrder(order, "complete"));
    actions.append(cancel, complete);
    article.append(actions);
  } else if (order.status === "COMPLETED") {
    article.append(makeText("p", "mt-3 text-xs text-emerald-700", `揀貨完成時間 ${formatDate(order.completed_at)}；庫存及格位已同步扣減。`));
  } else {
    article.append(makeText("p", "mt-3 text-xs text-slate-500", `取消時間 ${formatDate(order.cancelled_at)}；預留庫存已釋出。`));
  }
  return article;
}

async function updateOrder(order, action) {
  const isComplete = action === "complete";
  const message = isComplete
    ? `請先確認已依出貨單 ${order.outbound_no} 從指定批次與格位實際取出 ${Number(order.quantity).toLocaleString()} ${order.unit}「${order.product_name}」。\n\n確認後系統會扣減庫存並更新倉儲地圖。`
    : `確定取消出貨單 ${order.outbound_no} 嗎？取消後會釋放預留庫存。`;
  if (!window.confirm(message)) return;
  try {
    await requestJson(`/api/outbound-orders/${order.outbound_order_id}/${action}`, { method: "POST", body: "{}" });
    showToast(isComplete ? "出貨完成，庫存與格位已同步更新。" : "出貨單已取消，預留庫存已釋出。");
    await loadOrders();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadOrders() {
  const errorBox = document.getElementById("loadError");
  errorBox.classList.add("hidden");
  document.getElementById("emptyState").classList.add("hidden");
  ordersList.replaceChildren(makeText("p", "p-8 text-center text-sm text-slate-500", "正在載入出貨單…"));
  try {
    const all = await requestJson("/api/outbound-orders?status=ALL");
    document.getElementById("waitingCount").textContent = all.filter((order) => order.status === "WAITING_PICK").length;
    document.getElementById("completedCount").textContent = all.filter((order) => order.status === "COMPLETED").length;
    document.getElementById("cancelledCount").textContent = all.filter((order) => order.status === "CANCELLED").length;
    const shown = statusFilter.value === "ALL" ? all : all.filter((order) => order.status === statusFilter.value);
    ordersList.replaceChildren(...shown.map(renderOrder));
    document.getElementById("emptyState").classList.toggle("hidden", shown.length > 0);
  } catch (error) {
    ordersList.replaceChildren();
    errorBox.textContent = `${error.message} 請確認已執行出貨單資料庫更新檔，並重新整理頁面。`;
    errorBox.classList.remove("hidden");
  }
}

statusFilter.addEventListener("change", loadOrders);
document.getElementById("refreshButton").addEventListener("click", loadOrders);
const createdNo = new URLSearchParams(window.location.search).get("created");
if (createdNo) {
  document.getElementById("createdOrderNo").textContent = createdNo;
  document.getElementById("createdNotice").classList.remove("hidden");
  window.history.replaceState({}, "", "/shipments.html");
}
loadOrders();
