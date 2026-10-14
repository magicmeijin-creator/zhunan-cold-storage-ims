const $ = (id) => document.getElementById(id);
let storeData = null;
let toastTimer;

function escapeText(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char])); }
function toast(message, error = false) {
  const node = $("toast"); node.textContent = message;
  node.className = `fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-3 text-sm text-white shadow-lg ${error ? "bg-rose-700" : "bg-slate-900"}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.add("hidden"), 3500);
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type":"application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || "系統暫時無法完成操作。");
  return data;
}
function suggestion(product, stock, sales) {
  const avg = Number(sales || 0) / 7;
  const safety = Number(product.safetyStock || 0);
  const lead = Number(product.leadTimeDays || 1);
  const review = Number(product.reviewDays || 1);
  const buffer = Number(product.bufferStock || 0);
  return { avg: Math.round(avg * 10) / 10, reorder: Math.ceil(avg * lead + safety), qty: Math.max(0, Math.ceil(Math.ceil(avg * (lead + review) + safety + buffer) - Number(stock || 0))) };
}
function anomalyMessage(qty, suggested, unit) {
  const threshold = Math.max(suggested * 3, suggested + 50);
  return qty > threshold
    ? `申請量 ${qty} ${unit} 超過需確認門檻 ${threshold} ${unit}（建議量 ${suggested} ${unit}），請確認特殊需求並填寫原因。`
    : "";
}
function updateAnomaly(line) {
  const product = storeData.products.find(item => item.sku === line.dataset.sku);
  const qty = Number(line.querySelector('[data-field="qty"]').value || 0);
  const suggested = Number(line.dataset.suggested || 0);
  const message = anomalyMessage(qty, suggested, product.unit);
  const warning = line.querySelector('[data-role="anomaly"]');
  warning.textContent = message;
  warning.classList.toggle("hidden", !message);
  line.querySelector('[data-field="reason"]').required = Boolean(message);
}
function lineHtml(product) {
  const sales = Number(product.recentSalesTotal || 0);
  const stock = Number(product.currentStock || 0);
  const calc = suggestion(product, stock, sales);
  const unit = escapeText(product.unit);
  const precheck = calc.qty > 0 ? "checked" : "";
  const central = product.warehouseMatched ? `中央倉可供 ${Number(product.warehouseAvailableQty || 0)} ${escapeText(product.warehouseUnit || product.unit)}（${Number(product.warehouseBatchCount || 0)} 批）` : "中央倉商品尚未對應或目前無庫存";
  return `<article class="p-4 sm:p-5" data-sku="${escapeText(product.sku)}">
    <div class="flex flex-wrap items-start justify-between gap-3"><label class="flex items-start gap-3"><input class="mt-1 h-4 w-4 accent-emerald-700" type="checkbox" data-field="include" ${precheck}><span><strong class="text-base text-slate-900">${escapeText(product.name)}</strong><span class="ml-2 text-xs text-slate-500">${escapeText(product.sku)} · ${escapeText(product.category || "未分類")}</span></span></label><span class="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">${central}</span></div>
    <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <label class="text-xs font-semibold text-slate-600">近 7 日實際出貨<input data-field="sales" type="number" min="0" step="${unit === "kg" ? "0.01" : "1"}" value="${sales}" class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"><small class="mt-1 block font-normal">自動帶入 ${Number(product.recentSalesOrderCount || 0)} 張已完成出貨單，可核對後調整（${unit}）</small></label>
      <label class="text-xs font-semibold text-slate-600">門市盤點庫存<input data-field="stock" type="number" min="0" step="${unit === "kg" ? "0.01" : "1"}" value="${stock}" class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"><small class="mt-1 block font-normal">WMS 現有庫存預填，可核對後調整（${unit}）</small></label>
      <div class="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-900">建議補貨<strong data-role="suggestion" class="mt-1 block text-xl">${calc.qty} ${unit}</strong><small>日均 ${calc.avg} ${unit} · 再訂購點 ${calc.reorder} ${unit}</small></div>
      <label class="text-xs font-semibold text-slate-600">本次申請量<input data-field="qty" type="number" min="0" step="1" value="${calc.qty}" class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"><small class="mt-1 block font-normal">${unit}（整數）</small></label>
      <label class="text-xs font-semibold text-slate-600">調整原因<input data-field="reason" type="text" maxlength="300" placeholder="極端數量需填原因" class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"></label>
    </div>
    <p data-role="anomaly" class="mt-2 hidden text-xs font-semibold text-amber-700"></p>
    <p class="mt-2 text-xs text-slate-500">安全庫存 ${Number(product.safetyStock || 0)} ${unit} · 交期 ${Number(product.leadTimeDays || 1)} 天 · 補貨週期 ${Number(product.reviewDays || 1)} 天${product.salesDataConfigured === false ? " · 近 7 天沒有已完成出貨紀錄，銷量以 0 計算" : ""}</p>
  </article>`;
}
function updateLine(line) {
  const product = storeData.products.find(item => item.sku === line.dataset.sku);
  const sales = Number(line.querySelector('[data-field="sales"]').value || 0);
  const stock = Number(line.querySelector('[data-field="stock"]').value || 0);
  const qty = line.querySelector('[data-field="qty"]');
  const previous = Number(line.dataset.suggested);
  const result = suggestion(product, stock, sales);
  if (!qty.dataset.edited || Number(qty.value) === previous) qty.value = result.qty;
  line.dataset.suggested = result.qty;
  line.querySelector('[data-role="suggestion"]').textContent = `${result.qty} ${product.unit}`;
  updateAnomaly(line);
}
async function loadStore() {
  $("errorBox").classList.add("hidden"); $("successBox").classList.add("hidden");
  $("connectionStatus").textContent = "連線檢查中"; $("submitButton").disabled = true;
  try {
    storeData = await api("/api/replenishment/store");
    $("connectionStatus").textContent = "總部系統已連線";
    const products = storeData.products || [];
    $("productList").innerHTML = products.map(lineHtml).join("");
    $("emptyState").classList.toggle("hidden", products.length > 0);
    $("submitButton").disabled = products.length === 0;
    $("productList").querySelectorAll("article[data-sku]").forEach(line => {
      line.dataset.suggested = suggestion(storeData.products.find(p => p.sku === line.dataset.sku), Number(line.querySelector('[data-field="stock"]').value || 0), Number(line.querySelector('[data-field="sales"]').value || 0)).qty;
      line.querySelector('[data-field="qty"]').addEventListener("input", event => { event.currentTarget.dataset.edited = "true"; updateAnomaly(line); });
      line.addEventListener("input", event => { if (["sales", "stock"].includes(event.target.dataset.field)) updateLine(line); });
      updateAnomaly(line);
    });
    if (!storeData.warehouseConnection?.connected) {
      $("connectionStatus").textContent = "總部已連線 · 倉庫資料異常";
      $("errorBox").textContent = "補貨系統有回應，但無法取得 WMS 商品或庫存資料。請確認 WMS API 連線設定。";
      $("errorBox").classList.remove("hidden");
    }
  } catch (error) {
    $("connectionStatus").textContent = "總部未連線";
    $("errorBox").textContent = error.message; $("errorBox").classList.remove("hidden");
    $("emptyState").classList.remove("hidden");
  }
}
$("reloadButton").addEventListener("click", loadStore);
$("requestForm").addEventListener("submit", async event => {
  event.preventDefault();
  const lines = [...$("productList").querySelectorAll("article[data-sku]")].filter(line => line.querySelector('[data-field="include"]').checked);
  if (!lines.length) return toast("請至少勾選一項要申請的商品。", true);
  const items = lines.map(line => {
    const product = storeData.products.find(item => item.sku === line.dataset.sku);
    return { sku: product.sku, countedStock: Number(line.querySelector('[data-field="stock"]').value), recentSalesTotal: Number(line.querySelector('[data-field="sales"]').value), qty: Number(line.querySelector('[data-field="qty"]').value), reason: line.querySelector('[data-field="reason"]').value.trim() };
  });
  for (const [index, line] of lines.entries()) {
    const item = items[index];
    const suggested = Number(line.dataset.suggested);
    const anomaly = item.qty > Math.max(suggested * 3, suggested + 50);
    if (anomaly && !item.reason) { line.querySelector('[data-field="reason"]').focus(); return toast(`${storeData.products.find(p => p.sku === item.sku).name} 的申請量偏高，請填寫原因。`, true); }
  }
  if (!confirm(`確定將 ${items.length} 項補貨需求送交總部？總部審核通過後才會建立倉庫出貨單。`)) return;
  const button = $("submitButton"); button.disabled = true;
  try {
    const order = await api("/api/replenishment/orders", { method:"POST", body:JSON.stringify({ items }) });
    await loadStore();
    $("successBox").innerHTML = `<strong>補貨單已送交總部：${escapeText(order.id)}</strong><br>申請量已預填系統建議值，總部現在可在 EOS「總部訂單審核」查看與處理。`;
    $("successBox").classList.remove("hidden"); toast("補貨申請已送出並產生補貨單。");
    window.scrollTo({ top: 0, behavior:"smooth" });
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
loadStore();
