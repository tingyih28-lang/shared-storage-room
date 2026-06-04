const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "storage.json");

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
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ version: 1, items: [], logs: [] }, null, 2),
      "utf8"
    );
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

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
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

function now() {
  return new Date().toISOString();
}

function addLog(data, action, item, actor, quantity, note) {
  data.logs.unshift({
    id: crypto.randomUUID(),
    at: now(),
    action,
    itemId: item.id,
    itemName: item.name,
    actor: cleanText(actor, 60) || "未署名",
    quantity: cleanNumber(quantity),
    note: cleanText(note, 160)
  });
  data.logs = data.logs.slice(0, 300);
}

function listPayload() {
  const data = readData();
  return {
    version: data.version || 1,
    items: data.items || [],
    logs: data.logs || []
  };
}

async function handleApi(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/state") {
      return sendJson(res, 200, listPayload());
    }

    if (req.method === "POST" && req.url === "/api/items") {
      const body = await readBody(req);
      const data = readData();
      const item = {
        id: crypto.randomUUID(),
        name: cleanText(body.name),
        location: cleanText(body.location),
        quantity: cleanNumber(body.quantity),
        unit: cleanText(body.unit, 24) || "件",
        owner: cleanText(body.owner, 60),
        note: cleanText(body.note, 200),
        updatedAt: now()
      };
      if (!item.name || !item.location) {
        return sendJson(res, 400, { error: "物品名称和位置不能为空" });
      }
      data.items.unshift(item);
      addLog(data, "新增", item, body.actor, item.quantity, item.note);
      writeData(data);
      return sendJson(res, 200, listPayload());
    }

    const itemMatch = req.url.match(/^\/api\/items\/([^/]+)(?:\/(take|return))?$/);
    if (itemMatch && (req.method === "PUT" || req.method === "DELETE" || req.method === "POST")) {
      const [, id, actionPath] = itemMatch;
      const body = await readBody(req);
      const data = readData();
      const item = data.items.find(entry => entry.id === id);
      if (!item) return sendJson(res, 404, { error: "找不到这个物品" });

      if (req.method === "DELETE") {
        data.items = data.items.filter(entry => entry.id !== id);
        addLog(data, "删除", item, body.actor, item.quantity, body.note);
        writeData(data);
        return sendJson(res, 200, listPayload());
      }

      if (req.method === "PUT") {
        item.name = cleanText(body.name);
        item.location = cleanText(body.location);
        item.quantity = cleanNumber(body.quantity);
        item.unit = cleanText(body.unit, 24) || "件";
        item.owner = cleanText(body.owner, 60);
        item.note = cleanText(body.note, 200);
        item.updatedAt = now();
        if (!item.name || !item.location) {
          return sendJson(res, 400, { error: "物品名称和位置不能为空" });
        }
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
    sendJson(res, 500, { error: error.message || "服务器错误" });
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
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    res.end(content);
  });
}

ensureDataFile();

http
  .createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`共享储物间已启动: http://localhost:${PORT}`);
    console.log(`局域网用户可访问: http://本机IP:${PORT}`);
  });
