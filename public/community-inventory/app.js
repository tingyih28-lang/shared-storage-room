const state = { items: [], version: 0, activeTab: "upload", unclaimedOnly: false };

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
      state.items = (payload.items || []).map(item => ({ ...item, imageData: item.imageData || previous.get(item.id)?.imageData || "" }));
      const missingImages = state.items.filter(item => !item.imageData);
      const fullItems = await Promise.all(missingImages.map(item => api(`/api/found-items/${encodeURIComponent(item.id)}`)));
      fullItems.forEach((record, index) => { state.items.find(item => item.id === missingImages[index].id).imageData = record.item.imageData; });
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
  image.src = item.imageData;
  image.alt = `${item.name}的物资照片`;
  card.querySelector(".item-name").textContent = item.name;
  card.querySelector(".item-features").textContent = item.features;
  card.querySelector(".item-location").textContent = item.location;
  card.querySelector(".item-time").textContent = timeLabel(item.uploadedAt);
  const usesRow = card.querySelector(".item-uses-row");
  if (item.uses) card.querySelector(".item-uses").textContent = item.uses;
  else usesRow.hidden = true;

  const assigned = Boolean(item.department && item.activity);
  const status = card.querySelector(".item-status");
  status.textContent = assigned ? "已补充归属" : "待补充归属";
  status.classList.toggle("is-done", assigned);
  card.querySelector(".department-input").value = item.department || "";
  card.querySelector(".activity-input").value = item.activity || "";
  card.querySelector(".claim-form").addEventListener("submit", event => saveClaim(event, item.id));
  return fragment;
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
    return [item.department, item.activity, item.name, item.features, item.uses, item.location]
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
  uploadButton.disabled = true;
  uploadButton.textContent = "正在上传...";
  try {
    const imageData = await imageAsDataUrl(file);
    const form = new FormData(uploadForm);
    await api("/api/found-items", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        location: form.get("location"),
        features: form.get("features"),
        uses: form.get("uses"),
        imageData
      })
    });
    await loadItems(true);
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
  if (!department && !activity) return showToast("请至少填写所属部组或活动名称");
  button.disabled = true;
  button.textContent = "保存中";
  try {
    await api(`/api/found-items/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ department, activity })
    });
    await loadItems(true);
    showToast("归属信息已保存");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "保存归属";
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
setInterval(() => loadItems(true), 5000);
