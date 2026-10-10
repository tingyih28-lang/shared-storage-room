const state = { items: [], boxes: [], layout: {}, version: 0, activeTab: "upload", unclaimedOnly: false };

const uploadForm = document.querySelector("#uploadForm");
const photoInput = document.querySelector("#photoInput");
const photoPreview = document.querySelector("#photoPreview");
const photoPlaceholder = document.querySelector("#photoPlaceholder");
const uploadButton = document.querySelector("#uploadButton");
const syncStatus = document.querySelector("#syncStatus");
const recentItems = document.querySelector("#recentItems");
const identifiedItems = document.querySelector("#identifiedItems");
const searchInput = document.querySelector("#searchInput");
const departmentFilter = document.querySelector("#departmentFilter");
const activityFilter = document.querySelector("#activityFilter");
const showUnclaimed = document.querySelector("#showUnclaimed");
const template = document.querySelector("#itemTemplate");

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function timeLabel(value) {
  if (!value) return "时间未知";
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; }
  catch { throw new Error("服务器暂时没有返回完整内容，请稍后重试"); }
  if (!response.ok) throw new Error(payload?.error || `保存失败（${response.status}）`);
  return payload;
}

async function loadItems(silent = false) {
  try {
    const payload = await api(silent && state.version ? "/api/found-items?summary=1" : "/api/found-items");
    if (payload.version !== state.version || !silent) {
      state.version = payload.version;
      const previous = new Map(state.items.map(item => [item.id, item]));
      state.boxes = payload.boxes || [];
      state.layout = payload.layout || {};
      state.items = (payload.items || []).map(item => ({ ...item, imageData: item.imageData || previous.get(item.id)?.imageData || "" }));
      const missingImages = state.items.filter(item => !item.imageData);
      const fullItems = await Promise.all(missingImages.map(item => api(`/api/found-items/${encodeURIComponent(item.id)}`)));
      fullItems.forEach((record, index) => { state.items.find(item => item.id === missingImages[index].id).imageData = record.item.imageData; });
      updateAllLocationPickers();
      render();
    }
    syncStatus.textContent = "已同步到共享清单";
  } catch {
    syncStatus.textContent = "暂时无法连接共享清单";
  }
}

function escapeText(value) {
  return String(value || "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function makeCard(item) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".item-card");
  card.dataset.itemId = item.id;
  const image = card.querySelector(".item-image");
  image.src = item.imageData || "../assets/xiaoai-peek.png";
  image.alt = `${item.name}的物资照片`;
  card.querySelector(".item-name").textContent = item.name;
  card.querySelector(".item-features").textContent = item.features;
  card.querySelector(".item-location").textContent = item.location || "待整理，尚未放入箱袋";
  card.querySelector(".item-time").textContent = timeLabel(item.uploadedAt);
  card.querySelector(".item-actor").textContent = item.lastActor || "暂未记录";
  const usesRow = card.querySelector(".item-uses-row");
  if (item.uses) card.querySelector(".item-uses").textContent = item.uses;
  else usesRow.hidden = true;

  const assigned = Boolean(item.department && item.activity);
  const status = card.querySelector(".item-status");
  status.textContent = assigned ? "已补充归属" : "待补充归属";
  status.classList.toggle("is-done", assigned);
  card.querySelector(".department-input").value = item.department || "";
  card.querySelector(".activity-input").value = item.activity || "";
  card.querySelector(".actor-input").value = localStorage.getItem("storage-room-actor") || "";
  card.querySelector(".name-input").value = item.name || "";
  card.querySelector(".features-input").value = item.features || "";
  card.querySelector(".uses-input").value = item.uses || "";
  populateCardLocation(card, item);
  card.querySelector(".claim-form").addEventListener("submit", event => saveClaim(event, item.id));
  card.querySelector(".actor-input").addEventListener("input", event => {
    localStorage.setItem("storage-room-actor", event.currentTarget.value.trim());
  });
  card.querySelector(".image-input").addEventListener("change", event => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    imageAsDataUrl(file).then(value => { card.dataset.pendingImage = value; image.src = value; }).catch(error => showToast(error.message));
  });
  return fragment;
}

function cabinetOptions() {
  return Object.keys(state.layout).filter(name => name !== "地面");
}

function fillPicker(picker, item = {}) {
  const cabinet = picker.querySelector("[data-cabinet]");
  const shelf = picker.querySelector("[data-shelf]");
  const box = picker.querySelector("[data-box]");
  const priorCabinet = cabinet.value;
  const priorShelf = shelf.value;
  const priorBox = box.value;
  const cabinets = cabinetOptions();
  cabinet.replaceChildren(new Option("选择柜子", ""), ...cabinets.map(name => new Option(name, name)));
  const currentBox = state.boxes.find(entry => entry.id === (item.boxId || priorBox));
  const chosenCabinet = currentBox?.cabinet || item.cabinet || priorCabinet || "";
  cabinet.value = chosenCabinet;
  const count = Number(state.layout[chosenCabinet] || 0);
  const shelves = chosenCabinet.includes("木柜") ? ["整体"] : Array.from({ length: count }, (_, index) => `第${index + 1}层`);
  shelf.replaceChildren(new Option("选择层数", ""), ...shelves.map(name => new Option(name, name)));
  const chosenShelf = currentBox?.shelf || item.shelf || priorShelf || "";
  shelf.value = chosenShelf;
  const matches = state.boxes.filter(entry => entry.cabinet === cabinet.value && entry.shelf === shelf.value);
  box.replaceChildren(new Option(matches.length ? "选择箱子/袋子" : "本层暂无箱袋", ""), ...matches.map(entry => new Option(`${entry.label}（${entry.position}）`, entry.id)));
  const selected = item.boxId || priorBox;
  box.value = matches.some(entry => entry.id === selected) ? selected : "";
  cabinet.onchange = () => { shelf.value = ""; fillPicker(picker); };
  shelf.onchange = () => { box.value = ""; fillPicker(picker); };
}

function updateAllLocationPickers() {
  const upload = document.querySelector("#uploadForm [data-location-picker]");
  if (upload) fillPicker(upload);
}

function populateCardLocation(card, item) {
  const picker = card.querySelector(".card-location");
  fillPicker(picker, item);
}

function appendEmpty(container, title, description) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const text = document.createElement("span");
  text.textContent = description;
  empty.append(heading, text);
  container.appendChild(empty);
}

function setOptions(select, values, firstLabel) {
  const selected = select.value;
  select.replaceChildren(new Option(firstLabel, ""));
  values.forEach(value => select.add(new Option(value, value)));
  select.value = values.includes(selected) ? selected : "";
}

function updateSuggestionLists() {
  const departments = [...new Set(state.items.map(item => item.department).filter(Boolean))].sort();
  const activities = [...new Set(state.items.map(item => item.activity).filter(Boolean))].sort();
  document.querySelector("#departments").replaceChildren(...departments.map(value => new Option(value, value)));
  document.querySelector("#activities").replaceChildren(...activities.map(value => new Option(value, value)));
  setOptions(departmentFilter, departments, "全部部组");
  setOptions(activityFilter, activities, "全部活动");
}

function render() {
  const unclaimed = state.items.filter(item => !item.department || !item.activity);
  document.querySelector("#unclaimedCount").textContent = unclaimed.length;
  document.querySelector("#filterUnclaimedCount").textContent = unclaimed.length;
  document.querySelector("#totalCount").textContent = `${state.items.length} 件`;
  updateSuggestionLists();

  recentItems.replaceChildren();
  state.items.slice(0, 8).forEach(item => recentItems.appendChild(makeCard(item)));
  if (!state.items.length) appendEmpty(recentItems, "还没有待认领物资", "可以先上传物品照片和位置线索。 ");

  const query = searchInput.value.trim().toLocaleLowerCase();
  const found = state.items.filter(item => {
    if (state.unclaimedOnly && item.department && item.activity) return false;
    if (departmentFilter.value && item.department !== departmentFilter.value) return false;
    if (activityFilter.value && item.activity !== activityFilter.value) return false;
    if (!query) return true;
    return [item.department, item.activity, item.name, item.features, item.uses, item.location, item.lastActor]
      .some(value => String(value || "").toLocaleLowerCase().includes(query));
  });
  identifiedItems.replaceChildren();
  found.forEach(item => identifiedItems.appendChild(makeCard(item)));
  document.querySelector("#searchSummary").textContent = state.unclaimedOnly
    ? `显示待补充归属的物资 ${found.length} 件${state.items.length > 8 ? `；全部上传记录 ${state.items.length} 件` : ""}`
    : `找到 ${found.length} 件物资`;
  if (!found.length) {
    appendEmpty(
      identifiedItems,
      state.items.length ? "没有找到匹配的物资" : "还没有物资记录",
      state.items.length ? "试试调整搜索文字或筛选条件。" : "上传第一件物资后，大家就能一起补充归属。"
    );
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  const uploadActive = tab === "upload";
  document.querySelector("#uploadPanel").hidden = !uploadActive;
  document.querySelector("#identifyPanel").hidden = uploadActive;
  document.querySelector("#uploadTab").classList.toggle("is-active", uploadActive);
  document.querySelector("#identifyTab").classList.toggle("is-active", !uploadActive);
  document.querySelector("#uploadTab").setAttribute("aria-selected", String(uploadActive));
  document.querySelector("#identifyTab").setAttribute("aria-selected", String(!uploadActive));
  if (!uploadActive) searchInput.focus({ preventScroll: true });
}

async function imageAsDataUrl(file) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 15_000_000) throw new Error("原始图片超过 15 MB，请先压缩后再试");
  const canvas = document.createElement("canvas");
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1500 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
  } else {
    const source = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("无法读取这张图片"));
      image.src = URL.createObjectURL(file);
    });
    const scale = Math.min(1, 1500 / Math.max(source.width, source.height));
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(source.src);
  }
  const compressed = canvas.toDataURL("image/jpeg", 0.78);
  if (compressed.length > 1_950_000) throw new Error("图片压缩后仍然太大，请换一张分辨率较小的图片");
  return compressed;
}

photoInput.addEventListener("change", async () => {
  const file = photoInput.files?.[0];
  if (!file) return;
  try {
    photoPreview.src = await imageAsDataUrl(file);
    photoPreview.hidden = false;
    photoPlaceholder.hidden = true;
  } catch (error) {
    photoInput.value = "";
    photoPreview.hidden = true;
    photoPlaceholder.hidden = false;
    showToast(error.message);
  }
});

uploadForm.addEventListener("submit", async event => {
  event.preventDefault();
  const file = photoInput.files?.[0];
  if (!file) return showToast("请先选择物品图片");
  const form = new FormData(uploadForm);
  const actor = form.get("actor").trim();
  if (!actor) return showToast("请填写操作人");
  localStorage.setItem("storage-room-actor", actor);
  uploadButton.disabled = true;
  uploadButton.textContent = "正在上传...";
  try {
    const imageData = await imageAsDataUrl(file);
    await api("/api/found-items", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        boxId: form.get("boxId"),
        features: form.get("features"),
        uses: form.get("uses"),
        imageData,
        actor
      })
    });
    await loadItems(false);
    uploadForm.reset();
    photoPreview.removeAttribute("src");
    photoPreview.hidden = true;
    photoPlaceholder.hidden = false;
    showToast("物资信息已发布，大家都能看到了");
    switchTab("identify");
  } catch (error) {
    showToast(error.message);
  } finally {
    uploadButton.disabled = false;
    uploadButton.textContent = "发布物资信息";
  }
});

async function saveClaim(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector(".save-claim");
  const department = form.querySelector(".department-input").value.trim();
  const activity = form.querySelector(".activity-input").value.trim();
  const actor = form.querySelector(".actor-input").value.trim();
  const card = form.closest(".item-card");
  const name = form.querySelector(".name-input").value.trim();
  const features = form.querySelector(".features-input").value.trim();
  const uses = form.querySelector(".uses-input").value.trim();
  const boxId = form.querySelector("[data-box]").value;
  if (!actor) return showToast("请填写操作人");
  if (!name || !features) return showToast("物品名称和特征不能为空");
  localStorage.setItem("storage-room-actor", actor);
  button.disabled = true;
  button.textContent = "保存中";
  try {
    await api(`/api/found-items/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        department, activity, name, features, uses, boxId,
        ...(card.dataset.pendingImage ? { imageData: card.dataset.pendingImage } : {}),
        actor
      })
    });
    await loadItems(false);
    showToast("物资资料已同步到社办库存");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "保存共享信息";
  }
}

document.querySelector("#uploadTab").addEventListener("click", () => switchTab("upload"));
document.querySelector("#identifyTab").addEventListener("click", () => switchTab("identify"));
searchInput.addEventListener("input", render);
departmentFilter.addEventListener("change", render);
activityFilter.addEventListener("change", render);
document.querySelector("#clearSearch").addEventListener("click", () => {
  searchInput.value = "";
  departmentFilter.value = "";
  activityFilter.value = "";
  render();
  searchInput.focus();
});
showUnclaimed.addEventListener("click", () => {
  state.unclaimedOnly = !state.unclaimedOnly;
  showUnclaimed.classList.toggle("is-active", state.unclaimedOnly);
  showUnclaimed.setAttribute("aria-pressed", String(state.unclaimedOnly));
  render();
});

loadItems();
const uploadActorInput = uploadForm.querySelector("[name='actor']");
uploadActorInput.value = localStorage.getItem("storage-room-actor") || "";
uploadActorInput.addEventListener("input", event => {
  localStorage.setItem("storage-room-actor", event.currentTarget.value.trim());
});
setInterval(() => loadItems(true), 5000);
