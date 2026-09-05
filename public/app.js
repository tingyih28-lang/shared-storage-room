const locationConfig = [
  { name: "黑色柜子1", shelves: 3 },
  { name: "黑色柜子2", shelves: 4 },
  { name: "银色柜子1", shelves: 4 },
  { name: "银色柜子2", shelves: 3 },
  { name: "银色柜子3", shelves: 3 },
  { name: "银色柜子4", shelves: 4 },
  { name: "木柜（左）", shelves: 1, shelfNames: ["整体"] },
  { name: "木柜（右）", shelves: 1, shelfNames: ["整体"] },
  { name: "地面", shelves: 0 }
];

const modeCopy = {
  office: {
    title: "爱心社储物间",
    eyebrow: "进入社办",
    hero: "每一件物品，都能被认真找到和归还",
    text: "登记固定柜位、领取记录和归还数量，方便大家在活动前后快速确认物资状态。",
    form: "登记社办物品",
    list: "社办物品清单",
    place: "位置",
    search: "搜索物品、位置、操作人、负责人、备注",
    mascot: "./assets/xiaoai-wave.jpg"
  },
  keeper: {
    title: "骨干保管系统",
    eyebrow: "骨干保管",
    hero: "把分散保管的物资，也放进同一本清楚的账",
    text: "这里不记录地点，只记录保管骨干、数量和每一次领取归还，适合临时借放和活动流转。",
    form: "登记骨干保管物品",
    list: "骨干保管清单",
    place: "骨干名字",
    search: "搜索物品、骨干名字、操作人、负责人、备注",
    mascot: "./assets/xiaoai-peek.png"
  }
};

const state = {
  version: 0,
  items: [],
  logs: [],
  mode: ""
};

const portal = document.querySelector("#portal");
const appShell = document.querySelector("#appShell");
const itemForm = document.querySelector("#itemForm");
const editDialog = document.querySelector("#editDialog");
const editForm = document.querySelector("#editForm");
const detailDialog = document.querySelector("#detailDialog");
const quantityDialog = document.querySelector("#quantityDialog");
const quantityForm = document.querySelector("#quantityForm");
const itemsBody = document.querySelector("#itemsBody");
const emptyState = document.querySelector("#emptyState");
const searchInput = document.querySelector("#searchInput");
const actorInput = document.querySelector("#actorInput");
const syncStatus = document.querySelector("#syncStatus");
const itemCount = document.querySelector("#itemCount");
const logList = document.querySelector("#logList");
const toast = document.querySelector("#toast");

actorInput.value = localStorage.getItem("storage-room-actor") || "";
actorInput.addEventListener("input", () => {
  localStorage.setItem("storage-room-actor", actorInput.value.trim());
});

function actor() {
  return actorInput.value.trim();
}

function requireActor() {
  if (actor()) return true;
  actorInput.focus();
  showToast("请先填写操作人");
  return false;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function shelfOptions(config) {
  if (config.shelves === 0) return ["无层数"];
  if (config.shelfNames) return config.shelfNames;
  return Array.from({ length: config.shelves }, (_, index) => `第${index + 1}层`);
}

function populateLocationControls(form, selectedCabinet = locationConfig[0].name, selectedShelf = "") {
  const cabinetSelect = form.querySelector("[data-cabinet]");
  const shelfSelect = form.querySelector("[data-shelf]");
  if (!cabinetSelect || !shelfSelect) return;
  cabinetSelect.innerHTML = "";

  for (const config of locationConfig) {
    const option = document.createElement("option");
    option.value = config.name;
    option.textContent = config.name;
    cabinetSelect.appendChild(option);
  }

  cabinetSelect.value = locationConfig.some(config => config.name === selectedCabinet)
    ? selectedCabinet
    : locationConfig[0].name;

  function refreshShelves() {
    const config = locationConfig.find(entry => entry.name === cabinetSelect.value) || locationConfig[0];
    const options = shelfOptions(config);
    shelfSelect.innerHTML = "";
    for (const label of options) {
      const option = document.createElement("option");
      option.value = label;
      option.textContent = label;
      shelfSelect.appendChild(option);
    }
    shelfSelect.disabled = config.shelves === 0;
    shelfSelect.value = options.includes(selectedShelf) ? selectedShelf : options[0];
  }

  cabinetSelect.onchange = () => {
    selectedShelf = "";
    refreshShelves();
  };
  refreshShelves();
}

function buildLocation(data) {
  if (data.cabinet === "地面") return "地面";
  return `${data.cabinet} · ${data.shelf}`;
}

function parseLocation(location) {
  const text = String(location || "");
  if (text === "地面") return { cabinet: "地面", shelf: "无层数" };
  const [cabinet, shelf] = text.split(" · ");
  if (locationConfig.some(config => config.name === cabinet)) return { cabinet, shelf: shelf || "" };
  return { cabinet: locationConfig[0].name, shelf: "" };
}

async function api(url, options = {}) {
  if (location.protocol === "file:") {
    throw new Error("请先启动服务器，再通过 http://127.0.0.1:4173/ 访问");
  }
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "操作失败");
  updateState(payload);
  return payload;
}

function updateState(payload) {
  state.version = payload.version;
  state.items = payload.items || [];
  state.logs = payload.logs || [];
  render();
  syncStatus.textContent = `已同步，版本 ${state.version}`;
}

async function refresh(silent = false) {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const payload = await response.json();
    if (payload.version !== state.version) updateState(payload);
    if (!silent) syncStatus.textContent = `已同步，版本 ${payload.version}`;
  } catch {
    syncStatus.textContent = "同步失败，稍后会自动重试";
  }
}

function logsForItem(item) {
  return state.logs.filter(log => log.itemId === item.id);
}

function itemMatchesSearch(item, keyword) {
  const operationText = logsForItem(item)
    .map(log => [log.actor, log.action, log.note].join(" "))
    .join(" ");
  return [
    item.name,
    item.location,
    item.keeper,
    item.owner,
    item.note,
    item.lastActor,
    operationText
  ]
    .join(" ")
    .toLowerCase()
    .includes(keyword);
}

function currentItems() {
  const keyword = searchInput.value.trim().toLowerCase();
  return state.items
    .filter(item => (item.category || "office") === state.mode)
    .filter(item => !keyword || itemMatchesSearch(item, keyword));
}

function currentLogs() {
  return state.logs.filter(log => (log.category || "office") === state.mode);
}

function applyMode(mode) {
  state.mode = mode;
  const copy = modeCopy[mode];

  portal.hidden = true;
  appShell.hidden = false;
  document.querySelector("#pageTitle").textContent = copy.title;
  document.querySelector("#modeEyebrow").textContent = copy.eyebrow;
  document.querySelector("#heroTitle").textContent = copy.hero;
  document.querySelector("#heroText").textContent = copy.text;
  document.querySelector("#formTitle").textContent = copy.form;
  document.querySelector("#listTitle").textContent = copy.list;
  document.querySelector("#placeColumn").textContent = copy.place;
  document.querySelector("#heroMascot").src = copy.mascot;
  searchInput.placeholder = copy.search;

  setFormMode(itemForm, mode);
  render();
}

function setFormMode(form, mode) {
  const officeFields = form.querySelector("[data-location-picker]");
  const keeperInput = form.querySelector("[name='keeper']");
  const keeperField = keeperInput?.closest(".field");
  const isKeeper = mode === "keeper";

  if (officeFields) {
    officeFields.hidden = isKeeper;
    for (const control of officeFields.querySelectorAll("select")) {
      control.disabled = isKeeper;
      control.required = !isKeeper;
    }
  }

  if (keeperField && keeperInput) {
    keeperField.hidden = !isKeeper;
    keeperInput.disabled = !isKeeper;
    keeperInput.required = isKeeper;
  }
}

function render() {
  if (!state.mode) return;
  const items = currentItems();
  itemsBody.innerHTML = "";
  emptyState.style.display = items.length ? "none" : "block";
  itemCount.textContent = `${state.items.filter(item => (item.category || "office") === state.mode).length} 件物品`;

  for (const item of items) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><div class="item-name"></div><div class="muted"></div></td>
      <td></td>
      <td class="qty"></td>
      <td></td>
      <td></td>
      <td></td>
      <td>
        <div class="actions">
          <button data-action="detail" class="secondary">详情</button>
          <button data-action="take">领取</button>
          <button data-action="return" class="secondary">放入</button>
          <button data-action="edit" class="secondary">编辑</button>
          <button data-action="delete" class="danger">删除</button>
        </div>
      </td>
    `;
    row.querySelector(".item-name").textContent = item.name;
    row.querySelector(".muted").textContent = `更新 ${formatTime(item.updatedAt)}`;
    row.children[1].textContent = state.mode === "keeper" ? item.keeper || "-" : item.location || "-";
    row.children[2].textContent = `${item.quantity} ${item.unit}`;
    row.children[3].textContent = item.owner || "-";
    row.children[4].textContent = item.lastActor || "-";
    row.children[5].textContent = item.note || "-";
    const labels = ["物品", state.mode === "keeper" ? "骨干名字" : "位置", "数量", "负责人", "最近操作人", "备注", "操作"];
    row.querySelectorAll("td").forEach((cell, index) => {
      cell.dataset.label = labels[index];
    });
    row.querySelector("[data-action='detail']").addEventListener("click", () => openDetail(item));
    row.querySelector("[data-action='take']").addEventListener("click", () => changeQuantity(item, "take"));
    row.querySelector("[data-action='return']").addEventListener("click", () => changeQuantity(item, "return"));
    row.querySelector("[data-action='edit']").addEventListener("click", () => openEdit(item));
    row.querySelector("[data-action='delete']").addEventListener("click", () => deleteItem(item));
    itemsBody.appendChild(row);
  }

  logList.innerHTML = "";
  for (const log of currentLogs().slice(0, 24)) {
    const entry = document.createElement("li");
    entry.innerHTML = `
      <div class="log-title"><span></span><span class="tag"></span></div>
      <div class="log-meta"></div>
    `;
    entry.querySelector(".log-title span").textContent = log.itemName;
    entry.querySelector(".tag").textContent = log.action;
    entry.querySelector(".log-meta").textContent =
      `${formatTime(log.at)} · ${log.actor} · ${log.quantity || 0} 件${log.note ? ` · ${log.note}` : ""}`;
    logList.appendChild(entry);
  }
}

function openDetail(item) {
  document.querySelector("#detailType").textContent = state.mode === "keeper" ? "骨干保管详情" : "社办物品详情";
  document.querySelector("#detailName").textContent = item.name;

  const detailMeta = document.querySelector("#detailMeta");
  const placeLabel = state.mode === "keeper" ? "骨干名字" : "位置";
  const placeValue = state.mode === "keeper" ? item.keeper || "-" : item.location || "-";
  detailMeta.innerHTML = `
    <div><dt>${placeLabel}</dt><dd></dd></div>
    <div><dt>数量</dt><dd></dd></div>
    <div><dt>负责人</dt><dd></dd></div>
    <div><dt>最近操作人</dt><dd></dd></div>
    <div><dt>备注</dt><dd></dd></div>
  `;
  const values = [placeValue, `${item.quantity} ${item.unit}`, item.owner || "-", item.lastActor || "-", item.note || "-"];
  detailMeta.querySelectorAll("dd").forEach((dd, index) => {
    dd.textContent = values[index];
  });

  const detailLogs = document.querySelector("#detailLogs");
  detailLogs.innerHTML = "";
  const logs = logsForItem(item).slice(0, 10);
  if (!logs.length) {
    const empty = document.createElement("li");
    empty.textContent = "暂无操作记录";
    detailLogs.appendChild(empty);
  }
  for (const log of logs) {
    const entry = document.createElement("li");
    entry.innerHTML = `<strong></strong><span></span>`;
    entry.querySelector("strong").textContent = `${log.action} · ${log.actor}`;
    entry.querySelector("span").textContent =
      `${formatTime(log.at)} · ${log.quantity || 0} 件${log.note ? ` · ${log.note}` : ""}`;
    detailLogs.appendChild(entry);
  }
  detailDialog.showModal();
}

function changeQuantity(item, mode) {
  if (!requireActor()) return;
  const label = mode === "take" ? "领取" : "放入";
  quantityForm.reset();
  quantityForm.itemId.value = item.id;
  quantityForm.mode.value = mode;
  quantityForm.quantity.value = 1;
  document.querySelector("#quantityType").textContent = item.name;
  document.querySelector("#quantityTitle").textContent = `${label}物品`;
  document.querySelector("#quantitySubmit").textContent = `确认${label}`;
  quantityDialog.showModal();
}

quantityForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireActor()) return;
  const data = formData(quantityForm);
  const quantity = Number(data.quantity);
  const label = data.mode === "take" ? "领取" : "放入";
  try {
    await api(`/api/items/${data.itemId}/${data.mode}`, {
      method: "POST",
      body: JSON.stringify({ quantity, note: data.note, actor: actor() })
    });
    quantityDialog.close();
    showToast(`${label}已记录`);
  } catch (error) {
    showToast(error.message);
  }
});

function openEdit(item) {
  const category = item.category || "office";
  editForm.id.value = item.id;
  editForm.category.value = category;
  editForm.name.value = item.name;
  editForm.quantity.value = item.quantity;
  editForm.unit.value = item.unit;
  editForm.owner.value = item.owner || "";
  editForm.note.value = item.note || "";
  editForm.keeper.value = item.keeper || "";
  setFormMode(editForm, category);
  if (category === "office") {
    const parsed = parseLocation(item.location);
    populateLocationControls(editForm, parsed.cabinet, parsed.shelf);
  }
  editDialog.showModal();
}

async function deleteItem(item) {
  if (!requireActor()) return;
  if (!confirm(`确定删除“${item.name}”吗？`)) return;
  try {
    await api(`/api/items/${item.id}`, {
      method: "DELETE",
      body: JSON.stringify({ actor: actor(), note: "删除物品" })
    });
    showToast("已删除");
  } catch (error) {
    showToast(error.message);
  }
}

itemForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireActor()) return;
  const data = formData(itemForm);
  const body = {
    ...data,
    category: state.mode,
    location: state.mode === "office" ? buildLocation(data) : "",
    keeper: state.mode === "keeper" ? data.keeper : "",
    actor: actor()
  };
  try {
    await api("/api/items", {
      method: "POST",
      body: JSON.stringify(body)
    });
    itemForm.reset();
    itemForm.quantity.value = 1;
    itemForm.unit.value = "件";
    populateLocationControls(itemForm);
    setFormMode(itemForm, state.mode);
    showToast("已添加");
  } catch (error) {
    showToast(error.message);
  }
});

editForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireActor()) return;
  const data = formData(editForm);
  const body = {
    ...data,
    location: data.category === "office" ? buildLocation(data) : "",
    keeper: data.category === "keeper" ? data.keeper : "",
    actor: actor()
  };
  try {
    await api(`/api/items/${data.id}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    editDialog.close();
    showToast("已保存");
  } catch (error) {
    showToast(error.message);
  }
});

function init() {
  populateLocationControls(itemForm);
  populateLocationControls(editForm);
  document.querySelector("[data-close]").addEventListener("click", () => editDialog.close());
  document.querySelector("[data-detail-close]").addEventListener("click", () => detailDialog.close());
  document.querySelectorAll("[data-quantity-close]").forEach(button => {
    button.addEventListener("click", () => quantityDialog.close());
  });
  document.querySelector("#backToPortal").addEventListener("click", () => {
    state.mode = "";
    appShell.hidden = true;
    portal.hidden = false;
  });
  document.querySelectorAll("[data-enter-mode]").forEach(button => {
    button.addEventListener("click", () => applyMode(button.dataset.enterMode));
  });
  searchInput.addEventListener("input", render);
  if (location.protocol === "file:") {
    document.querySelector("#fileWarning").hidden = false;
    syncStatus.textContent = "当前仅为静态预览";
  } else {
    refresh();
    setInterval(() => refresh(true), 3000);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
