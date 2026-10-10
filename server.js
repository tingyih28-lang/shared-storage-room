const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.STORAGE_DATA_DIR || path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "storage.json");

const storageShelves = {
  "黑色柜子1": ["第1层", "第2层", "第3层"],
  "黑色柜子2": ["第1层", "第2层", "第3层", "第4层"],
  "银色柜子1": ["第1层", "第2层", "第3层", "第4层"],
  "银色柜子2": ["第1层", "第2层", "第3层"],
  "银色柜子3": ["第1层", "第2层", "第3层"],
  "银色柜子4": ["第1层", "第2层", "第3层", "第4层"],
  "木柜（左）": ["整体"],
  "木柜（右）": ["整体"],
  "地面": ["无层数"]
};
const DEFAULT_LAYOUT = Object.fromEntries(Object.entries(storageShelves).map(([cabinet, shelves]) => [
  cabinet,
  shelves[0] === "无层数" ? 0 : shelves[0] === "整体" ? 1 : shelves.length
]));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg"
};

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 1, items: [], logs: [], boxes: [], layout: DEFAULT_LAYOUT }, null, 2), "utf8");
  }
}

function migrateData(data) {
  let changed = false;
  if (!Array.isArray(data.items)) { data.items = []; changed = true; }
  if (!Array.isArray(data.logs)) { data.logs = []; changed = true; }
  if (!Array.isArray(data.boxes)) { data.boxes = []; changed = true; }
  if (!data.layout || typeof data.layout !== "object") { data.layout = { ...DEFAULT_LAYOUT }; changed = true; }
  const foundItems = Array.isArray(data.foundItems) ? data.foundItems : [];
  const existingIds = new Set(data.items.map(item => item.id));
  for (const found of foundItems) {
    if (existingIds.has(found.id)) continue;
    data.items.unshift({ ...found, category: "office", quantity: 1, unit: "件", owner: "", note: "", lastActor: "", boxId: found.boxId || "", location: found.location || "待整理", foundItem: true });
    changed = true;
  }
  if (Object.hasOwn(data, "foundItems")) { delete data.foundItems; changed = true; }
  return changed;
}

function readData() {
  ensureDataFile();
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (migrateData(data)) {
    data.version = (data.version || 0) + 1;
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  }
  return data;
}

function writeData(data) {
  ensureDataFile();
  data.version = (data.version || 0) + 1;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function readBody(req, maxBytes = 3_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    let rejected = false;
    req.on("data", chunk => {
      if (rejected) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        rejected = true;
        const error = new Error("图片或表单内容太大，请换一张较小的图片");
        error.status = 400;
        reject(error);
      }
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON 格式错误"));
      }
    });
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function cleanText(value, maxLength = 120) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.floor(number));
}

function cleanCategory(value) {
  return value === "keeper" ? "keeper" : "office";
}

function now() {
  return new Date().toISOString();
}

function normalizeItem(item) {
  item.category ||= "office";
  item.keeper ||= "";
  item.location ||= "";
  item.lastActor ||= "";
  return item;
}

function requireActor(value) {
  const actor = cleanText(value, 60);
  if (!actor) {
    const error = new Error("请填写操作人");
    error.status = 400;
    throw error;
  }
  return actor;
}

function layoutShelves(data) {
  const layout = { ...DEFAULT_LAYOUT, ...(data.layout || {}) };
  return Object.fromEntries(Object.entries(layout).map(([cabinet, rawCount]) => {
    if (cabinet === "地面") return [cabinet, ["无层数"]];
    if (cabinet === "木柜（左）" || cabinet === "木柜（右）") return [cabinet, ["整体"]];
    const count = Math.max(0, Math.min(12, Math.floor(Number(rawCount) || 0)));
    return [cabinet, Array.from({ length: count }, (_, index) => `第${index + 1}层`)];
  }));
}

function findBox(data, id) {
  return id ? (data.boxes || []).find(box => box.id === id) || null : null;
}

function itemLocation(data, boxId, fallback = "") {
  const box = findBox(data, boxId);
  return box ? `${box.cabinet} · ${box.shelf} · ${box.label}` : cleanText(fallback, 160);
}

function buildBox(body, data, id = crypto.randomUUID(), createdAt = now()) {
  const cabinet = cleanText(body.cabinet, 40);
  const shelf = cleanText(body.shelf, 20);
  const documentUrl = cleanText(body.documentUrl, 500);
  let validDocumentUrl = false;
  try {
    const parsedUrl = new URL(documentUrl);
    validDocumentUrl = parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    validDocumentUrl = false;
  }

  const box = {
    id,
    label: cleanText(body.label, 80),
    kind: body.kind === "bag" ? "袋子" : "箱子",
    cabinet,
    shelf,
    position: cleanText(body.position, 100),
    department: cleanText(body.department, 80),
    activity: cleanText(body.activity, 100),
    documentUrl,
    updatedBy: requireActor(body.actor),
    createdAt,
    updatedAt: now()
  };

  if (!box.label) throw Object.assign(new Error("请填写储物箱名称或编号"), { status: 400 });
  const shelves = layoutShelves(data);
  if (!shelves[cabinet]) throw Object.assign(new Error("请选择有效的柜子或区域"), { status: 400 });
  if (!shelves[cabinet].includes(shelf)) throw Object.assign(new Error("请选择有效的层数"), { status: 400 });
  if (!box.position) throw Object.assign(new Error("请填写储物箱的具体位置"), { status: 400 });
  if (documentUrl && !validDocumentUrl) throw Object.assign(new Error("物资清单链接格式不正确"), { status: 400 });
  return box;
}

function addLog(data, action, item, actor, quantity, note) {
  const cleanActor = requireActor(actor);

  data.logs.unshift({
    id: crypto.randomUUID(),
    at: now(),
    action,
    itemId: item.id,
    itemName: item.name,
    category: cleanCategory(item.category),
    actor: cleanActor,
    quantity: cleanNumber(quantity),
    note: cleanText(note, 160)
  });
  item.lastActor = cleanActor;
  data.logs = data.logs.slice(0, 500);
}

function listPayload() {
  const data = readData();
  const boxMap = new Map((data.boxes || []).map(box => [box.id, box]));
  const items = (data.items || []).map(item => {
    const normalized = normalizeItem({ ...item });
    normalized.hasImage = Boolean(normalized.imageData);
    delete normalized.imageData;
    const box = boxMap.get(normalized.boxId);
    if (box) normalized.location = `${box.cabinet} · ${box.shelf} · ${box.label}`;
    return normalized;
  });
  return {
    version: data.version || 1,
    items,
    logs: data.logs || [],
    boxes: data.boxes || [],
    layout: { ...DEFAULT_LAYOUT, ...(data.layout || {}) }
  };
}

function officeItems(data) {
  return (data.items || []).filter(item => cleanCategory(item.category) === "office");
}

function validateItem(item) {
  if (!item.name) return "物品名称不能为空";
  if (item.category === "office" && !item.location) return "请选择位置";
  if (item.category === "keeper" && !item.keeper) return "请填写骨干名字";
  return "";
}

async function handleApi(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, listPayload());
    }
    if (req.method === "GET" && url.pathname === "/api/found-items") {
      const data = readData();
      const items = officeItems(data);
      const visibleItems = url.searchParams.get("summary") === "1" ? items.map(item => {
        const { imageData, ...summary } = item;
        return { ...summary, hasImage: Boolean(imageData) };
      }) : items;
      return sendJson(res, 200, { version: data.version || 1, items: visibleItems, boxes: data.boxes || [], layout: { ...DEFAULT_LAYOUT, ...(data.layout || {}) } });
    }
    const foundItemGetMatch = url.pathname.match(/^\/api\/found-items\/([^/]+)$/);
    if (req.method === "GET" && foundItemGetMatch) {
      const data = readData();
      const item = officeItems(data).find(entry => entry.id === foundItemGetMatch[1]);
      if (!item) return sendJson(res, 404, { error: "找不到这件物资" });
      return sendJson(res, 200, { item });
    }
    const itemGetMatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (req.method === "GET" && itemGetMatch) {
      const data = readData();
      const item = (data.items || []).find(entry => entry.id === itemGetMatch[1]);
      if (!item) return sendJson(res, 404, { error: "找不到这个物品" });
      return sendJson(res, 200, { item });
    }

    if (req.method === "POST" && url.pathname === "/api/found-items") {
      const body = await readBody(req);
      const name = cleanText(body.name, 100);
      const features = cleanText(body.features, 1000);
      const uses = cleanText(body.uses, 500);
      const boxId = cleanText(body.boxId, 64);
      const imageData = String(body.imageData || "");
      if (!name) return sendJson(res, 400, { error: "请填写物品名称" });
      if (!features) return sendJson(res, 400, { error: "请填写物品特征" });
      if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData)) {
        return sendJson(res, 400, { error: "请选择 JPG、PNG 或 WebP 图片" });
      }
      if (Buffer.byteLength(imageData, "utf8") > 2_100_000) {
        return sendJson(res, 400, { error: "图片太大，请重新选择或压缩后上传" });
      }
      const timestamp = now();
      const data = readData();
      if (boxId && !findBox(data, boxId)) return sendJson(res, 400, { error: "所选箱袋已不存在，请重新选择" });
      const location = itemLocation(data, boxId, body.location) || "待整理";
      const item = {
        id: crypto.randomUUID(), category: "office", foundItem: true, name, features, uses,
        boxId, location, imageData, department: "", activity: "", uploadedAt: timestamp,
        quantity: 1, unit: "件", owner: "", note: "", lastActor: "", updatedAt: timestamp
      };
      data.items.unshift(item);
      addLog(data, "新增待认领物资", item, body.actor || "共同编辑者", 1, location);
      writeData(data);
      return sendJson(res, 200, { id: item.id, version: data.version });
    }

    const foundItemMatch = url.pathname.match(/^\/api\/found-items\/([^/]+)$/);
    if (req.method === "PUT" && foundItemMatch) {
      const body = await readBody(req);
      const data = readData();
      const item = officeItems(data).find(entry => entry.id === foundItemMatch[1]);
      if (!item) return sendJson(res, 404, { error: "找不到这件物资" });
      const name = cleanText(body.name ?? item.name, 100);
      const features = cleanText(body.features ?? item.features, 1000);
      const imageData = String(body.imageData ?? item.imageData ?? "");
      if (!name || !features) return sendJson(res, 400, { error: "物品名称和特征不能为空" });
      if (imageData && (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData) || Buffer.byteLength(imageData, "utf8") > 2_100_000)) {
        return sendJson(res, 400, { error: "图片格式无效或文件太大" });
      }
      const boxId = cleanText(body.boxId ?? item.boxId, 64);
      if (boxId && !findBox(data, boxId)) return sendJson(res, 400, { error: "所选箱袋已不存在，请重新选择" });
      item.name = name;
      item.features = features;
      item.uses = cleanText(body.uses ?? item.uses, 500);
      item.imageData = imageData;
      item.department = cleanText(body.department, 100);
      item.activity = cleanText(body.activity, 120);
      item.boxId = boxId;
      item.location = itemLocation(data, boxId, "待整理") || "待整理";
      item.updatedAt = now();
      addLog(data, "更新物资资料", item, body.actor || "共同编辑者", item.quantity || 1, "待认领页面");
      writeData(data);
      return sendJson(res, 200, { id: item.id, version: data.version });
    }

    if (req.method === "POST" && url.pathname === "/api/boxes") {
      const body = await readBody(req);
      const data = readData();
      const box = buildBox(body, data);
      data.boxes ||= [];
      data.boxes.push(box);
      writeData(data);
      return sendJson(res, 200, listPayload());
    }

    if ((req.method === "POST" || req.method === "PUT") && url.pathname === "/api/layout") {
      const body = await readBody(req);
      const data = readData();
      requireActor(body.actor);
      const layout = { ...DEFAULT_LAYOUT, ...(data.layout || {}) };
      for (const [cabinet, rawCount] of Object.entries(body.layout || {})) {
        if (!Object.hasOwn(storageShelves, cabinet)) throw Object.assign(new Error("包含无效的柜子"), { status: 400 });
        let count = cleanNumber(rawCount);
        if (cabinet === "木柜（左）" || cabinet === "木柜（右）" || cabinet === "地面") count = DEFAULT_LAYOUT[cabinet];
        if (count > 12) throw Object.assign(new Error("每个柜子最多设置 12 层"), { status: 400 });
        const shelves = layoutShelves({ layout: { ...layout, [cabinet]: count } })[cabinet];
        if ((data.boxes || []).some(box => box.cabinet === cabinet && !shelves.includes(box.shelf))) {
          throw Object.assign(new Error(`${cabinet} 减层会影响已有箱袋，请先移动箱袋`), { status: 400 });
        }
        layout[cabinet] = count;
      }
      data.layout = layout;
      writeData(data);
      return sendJson(res, 200, listPayload());
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const body = await readBody(req);
      const data = readData();
      const category = cleanCategory(body.category);
      const boxId = category === "office" ? cleanText(body.boxId, 64) : "";
      if (boxId && !findBox(data, boxId)) return sendJson(res, 400, { error: "所选箱袋已不存在，请重新选择" });
      const imageData = String(body.imageData || "");
      if (category === "office" && imageData && (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData) || Buffer.byteLength(imageData, "utf8") > 2_100_000)) {
        return sendJson(res, 400, { error: "图片格式无效或文件太大" });
      }
      const item = {
        id: crypto.randomUUID(),
        category,
        name: cleanText(body.name),
        boxId,
        location: category === "office" ? itemLocation(data, boxId, body.location) : "",
        features: cleanText(body.features, 1000),
        uses: cleanText(body.uses, 500),
        department: cleanText(body.department, 100),
        activity: cleanText(body.activity, 120),
        imageData,
        uploadedAt: now(),
        keeper: category === "keeper" ? cleanText(body.keeper, 60) : "",
        quantity: cleanNumber(body.quantity),
        unit: cleanText(body.unit, 24) || "件",
        owner: cleanText(body.owner, 60),
        note: cleanText(body.note, 200),
        lastActor: "",
        updatedAt: now()
      };
      const validationError = validateItem(item);
      if (validationError) return sendJson(res, 400, { error: validationError });
      if (category === "office" && (!boxId || !item.features || !imageData)) return sendJson(res, 400, { error: "社办物品需要选择箱袋并填写特征、上传照片" });
      data.items.unshift(item);
      addLog(data, "新增", item, body.actor, item.quantity, item.note);
      writeData(data);
      return sendJson(res, 200, listPayload());
    }

    const boxMatch = url.pathname.match(/^\/api\/boxes\/([^/]+)$/);
    if (boxMatch && (req.method === "PUT" || req.method === "DELETE")) {
      const body = await readBody(req);
      const data = readData();
      const boxes = data.boxes || [];
      const index = boxes.findIndex(entry => entry.id === boxMatch[1]);
      if (index < 0) return sendJson(res, 404, { error: "找不到这个储物箱" });

      if (req.method === "DELETE") {
        requireActor(body.actor);
        if ((data.items || []).some(item => item.boxId === boxMatch[1])) return sendJson(res, 400, { error: "这个箱袋仍关联着物资，请先把物资移到其他位置" });
        data.boxes = boxes.filter(entry => entry.id !== boxMatch[1]);
      } else {
        const current = boxes[index];
        boxes[index] = buildBox(body, data, current.id, current.createdAt);
        data.boxes = boxes;
        for (const item of data.items || []) if (item.boxId === current.id) item.location = itemLocation(data, current.id);
      }
      writeData(data);
      return sendJson(res, 200, listPayload());
    }

    const itemMatch = url.pathname.match(/^\/api\/items\/([^/]+)(?:\/(take|return))?$/);
    if (itemMatch && (req.method === "PUT" || req.method === "DELETE" || req.method === "POST")) {
      const [, id, actionPath] = itemMatch;
      const body = await readBody(req);
      const data = readData();
      const item = (data.items || []).find(entry => entry.id === id);
      if (!item) return sendJson(res, 404, { error: "找不到这个物品" });
      normalizeItem(item);

      if (req.method === "DELETE") {
        addLog(data, "删除", item, body.actor, item.quantity, body.note);
        data.items = data.items.filter(entry => entry.id !== id);
        writeData(data);
      return sendJson(res, 200, listPayload());
      }

      if (req.method === "PUT") {
        const category = cleanCategory(body.category || item.category);
        item.category = category;
        item.name = cleanText(body.name);
        item.location = category === "office" ? cleanText(body.location) : "";
        item.boxId = category === "office" ? cleanText(body.boxId, 64) : "";
        if (item.boxId && !findBox(data, item.boxId)) return sendJson(res, 400, { error: "所选箱袋已不存在，请重新选择" });
        if (item.boxId) item.location = itemLocation(data, item.boxId);
        item.keeper = category === "keeper" ? cleanText(body.keeper, 60) : "";
        item.features = cleanText(body.features ?? item.features, 1000);
        item.uses = cleanText(body.uses ?? item.uses, 500);
        item.department = cleanText(body.department ?? item.department, 100);
        item.activity = cleanText(body.activity ?? item.activity, 120);
        if (Object.hasOwn(body, "imageData")) item.imageData = String(body.imageData || "");
        item.quantity = cleanNumber(body.quantity);
        item.unit = cleanText(body.unit, 24) || "件";
        item.owner = cleanText(body.owner, 60);
        item.note = cleanText(body.note, 200);
        item.updatedAt = now();
        const validationError = validateItem(item);
        if (validationError) return sendJson(res, 400, { error: validationError });
        addLog(data, "修改", item, body.actor, item.quantity, item.note);
        writeData(data);
      return sendJson(res, 200, listPayload());
      }

      if (req.method === "POST" && actionPath) {
        const amount = cleanNumber(body.quantity || 1);
        if (amount <= 0) return sendJson(res, 400, { error: "数量必须大于 0" });
        if (actionPath === "take" && item.quantity < amount) {
          return sendJson(res, 400, { error: "库存数量不够" });
        }
        item.quantity += actionPath === "return" ? amount : -amount;
        item.updatedAt = now();
        addLog(data, actionPath === "return" ? "归还/放入" : "领取", item, body.actor, amount, body.note);
        writeData(data);
      return sendJson(res, 200, listPayload());
      }
    }

    sendJson(res, 404, { error: "接口不存在" });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "服务器错误" });
  }
}

function serveStatic(req, res) {
  const rawPath = decodeURIComponent(req.url.split("?")[0]);
  const safePath = rawPath === "/" ? "/index.html" : rawPath;
  let filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(content);
  });
}

function startServer() {
  ensureDataFile();
  http
    .createServer((req, res) => {
      if (req.url.startsWith("/api/")) {
        handleApi(req, res);
        return;
      }
      serveStatic(req, res);
    })
    .listen(PORT, "::", () => {
      console.log(`共享储物间已启动: http://localhost:${PORT}`);
      console.log(`IPv4 用户可访问: http://本机IPv4:${PORT}`);
      console.log(`IPv6 用户可访问: http://[本机IPv6]:${PORT}`);
    });
}

startServer();
