const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
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
    fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 1, items: [], logs: [] }, null, 2), "utf8");
  }
}

function readData() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeData(data) {
  ensureDataFile();
  data.version = (data.version || 0) + 1;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("请求内容太大"));
        req.destroy();
      }
    });
    req.on("end", () => {
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

function buildBox(body, id = crypto.randomUUID(), createdAt = now()) {
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
  if (!storageShelves[cabinet]) throw Object.assign(new Error("请选择有效的柜子或区域"), { status: 400 });
  if (!storageShelves[cabinet].includes(shelf)) throw Object.assign(new Error("请选择有效的层数"), { status: 400 });
  if (!box.position) throw Object.assign(new Error("请填写储物箱的具体位置"), { status: 400 });
  if (!box.department) throw Object.assign(new Error("请填写所属部组"), { status: 400 });
  if (!validDocumentUrl) throw Object.assign(new Error("请填写有效的物资清单文档链接"), { status: 400 });
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
  return {
    version: data.version || 1,
    items: (data.items || []).map(normalizeItem),
    logs: data.logs || [],
    boxes: data.boxes || []
  };
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

    if (req.method === "POST" && url.pathname === "/api/boxes") {
      const body = await readBody(req);
      const data = readData();
      const box = buildBox(body);
      data.boxes ||= [];
      data.boxes.push(box);
      writeData(data);
      return sendJson(res, 200, listPayload());
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const body = await readBody(req);
      const data = readData();
      const category = cleanCategory(body.category);
      const item = {
        id: crypto.randomUUID(),
        category,
        name: cleanText(body.name),
        location: category === "office" ? cleanText(body.location) : "",
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
        data.boxes = boxes.filter(entry => entry.id !== boxMatch[1]);
      } else {
        const current = boxes[index];
        boxes[index] = buildBox(body, current.id, current.createdAt);
        data.boxes = boxes;
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
        item.keeper = category === "keeper" ? cleanText(body.keeper, 60) : "";
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
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
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
