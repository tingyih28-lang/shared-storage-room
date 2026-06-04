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

const state = {
  version: 0,
  items: [],
  logs: []
};

const itemForm = document.querySelector("#itemForm");
const editDialog = document.querySelector("#editDialog");
const editForm = document.querySelector("#editForm");
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
  return actorInput.value.trim() || "未署名";
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
  if (locationConfig.some(config => config.name === cabinet)) {
    return { cabinet, shelf: shelf || "" };
  }
  return { cabinet: locationConfig[0].name, shelf: "" };
}

async function api(url, options = {}) {
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

function filteredItems() {
  const keyword = searchInput.value.trim().toLowerCase();
  if (!keyword) return state.items;
  return state.items.filter(item => {
    return [item.name, item.location, item.owner, item.note]
      .join(" ")
      .toLowerCase()
      .includes(keyword);
  });
}

function render() {
  const items = filteredItems();
  itemsBody.innerHTML = "";
  emptyState.style.display = items.length ? "none" : "block";
  itemCount.textContent = `${state.items.length} 件物品`;

  for (const item of items) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><div class="item-name"></div><div class="muted"></div></td>
      <td></td>
      <td class="qty"></td>
      <td></td>
      <td></td>
      <td>
        <div class="actions">
          <button data-action="take">领取</button>
          <button data-action="return" class="secondary">放入</button>
          <button data-action="edit" class="secondary">编辑</button>
          <button data-action="delete" class="danger">删除</button>
        </div>
      </td>
    `;
    row.querySelector(".item-name").textContent = item.name;
    row.querySelector(".muted").textContent = `更新 ${formatTime(item.updatedAt)}`;
    row.children[1].textContent = item.location;
    row.children[2].textContent = `${item.quantity} ${item.unit}`;
    row.children[3].textContent = item.owner || "-";
    row.children[4].textContent = item.note || "-";
    row.querySelector("[data-action='take']").addEventListener("click", () => changeQuantity(item, "take"));
    row.querySelector("[data-action='return']").addEventListener("click", () => changeQuantity(item, "return"));
    row.querySelector("[data-action='edit']").addEventListener("click", () => openEdit(item));
    row.querySelector("[data-action='delete']").addEventListener("click", () => deleteItem(item));
    itemsBody.appendChild(row);
  }

  logList.innerHTML = "";
  for (const log of state.logs.slice(0, 24)) {
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

async function changeQuantity(item, mode) {
  const label = mode === "take" ? "领取" : "放入";
  const rawAmount = prompt(`${label}数量`, "1");
  if (rawAmount === null) return;
  const quantity = Number(rawAmount);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    showToast("请输入大于 0 的数量");
    return;
  }
  const note = prompt("备注，可留空", "") || "";
  try {
    await api(`/api/items/${item.id}/${mode}`, {
      method: "POST",
      body: JSON.stringify({ quantity, note, actor: actor() })
    });
    showToast(`${label}已记录`);
  } catch (error) {
    showToast(error.message);
  }
}

function openEdit(item) {
  const parsed = parseLocation(item.location);
  editForm.id.value = item.id;
  editForm.name.value = item.name;
  editForm.quantity.value = item.quantity;
  editForm.unit.value = item.unit;
  editForm.owner.value = item.owner || "";
  editForm.note.value = item.note || "";
  populateLocationControls(editForm, parsed.cabinet, parsed.shelf);
  editDialog.showModal();
}

async function deleteItem(item) {
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
  const data = formData(itemForm);
  try {
    await api("/api/items", {
      method: "POST",
      body: JSON.stringify({ ...data, location: buildLocation(data), actor: actor() })
    });
    itemForm.reset();
    itemForm.quantity.value = 1;
    itemForm.unit.value = "件";
    populateLocationControls(itemForm);
    showToast("已添加");
  } catch (error) {
    showToast(error.message);
  }
});

editForm.addEventListener("submit", async event => {
  event.preventDefault();
  const data = formData(editForm);
  try {
    await api(`/api/items/${data.id}`, {
      method: "PUT",
      body: JSON.stringify({ ...data, location: buildLocation(data), actor: actor() })
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
  searchInput.addEventListener("input", render);
  refresh();
  setInterval(() => refresh(true), 3000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
