const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "storage.json");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const PASSWORD_ITERATIONS = 310_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 6;
const SESSION_COOKIE = "storage_admin_session";
const sessions = new Map();
const loginAttempts = new Map();

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

function passwordRecord(password, mustChange = false) {
  if (password.length < 10) throw Object.assign(new Error("管理员密码至少需要 10 个字符"), { status: 400 });
  if (password.length > 128) throw Object.assign(new Error("管理员密码不能超过 128 个字符"), { status: 400 });
  const salt = crypto.randomBytes(16);
  const digest = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
  return {
    salt: salt.toString("base64"),
    hash: digest.toString("base64"),
    iterations: PASSWORD_ITERATIONS,
    mustChange: Boolean(mustChange),
    updatedAt: now()
  };
}

function setAdminPassword(password, mustChange = false) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(passwordRecord(password, mustChange), null, 2), { mode: 0o600 });
  fs.chmodSync(AUTH_FILE, 0o600);
}

function ensureAuthFile() {
  if (fs.existsSync(AUTH_FILE)) return;
  const temporaryPassword = process.env.INITIAL_ADMIN_PASSWORD || crypto.randomBytes(12).toString("base64url");
  setAdminPassword(temporaryPassword, true);
  console.log(`管理员临时密码: ${temporaryPassword}`);
}

function readAuth() {
  ensureAuthFile();
  return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
}

function verifyPassword(password) {
  try {
    const record = readAuth();
    const salt = Buffer.from(record.salt, "base64");
    const expected = Buffer.from(record.hash, "base64");
    const actual = crypto.pbkdf2Sync(String(password || ""), salt, Number(record.iterations), expected.length, "sha256");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  const nowMs = Date.now();
  for (const [key, expiry] of sessions) {
    if (expiry <= nowMs) sessions.delete(key);
  }
  sessions.set(token, nowMs + SESSION_TTL_MS);
  return token;
}

function sessionToken(req) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return "";
}

function isAuthenticated(req) {
  const token = sessionToken(req);
  const expiry = sessions.get(token) || 0;
  if (!token || expiry <= Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

function requireAdmin(req) {
  if (!isAuthenticated(req)) {
    throw Object.assign(new Error("请先登录管理员账户"), { status: 401 });
  }
}

function loginAllowed(clientIp) {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  const recent = (loginAttempts.get(clientIp) || []).filter(stamp => stamp > cutoff);
  loginAttempts.set(clientIp, recent);
  return recent.length < LOGIN_ATTEMPT_LIMIT;
}

function sessionCookie(token, maxAgeSeconds = SESSION_TTL_MS / 1000) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
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

function listPayload(authenticated = false) {
  const data = readData();
  const auth = readAuth();
  return {
    version: data.version || 1,
    items: (data.items || []).map(normalizeItem),
    logs: data.logs || [],
    boxes: data.boxes || [],
    auth: {
      authenticated: Boolean(authenticated),
      mustChange: Boolean(authenticated && auth.mustChange)
    }
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
    if (req.method === "GET" && ["/api/state", "/api/auth/status"].includes(url.pathname)) {
      return sendJson(res, 200, listPayload(isAuthenticated(req)));
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const clientIp = req.socket.remoteAddress || "unknown";
      if (!loginAllowed(clientIp)) {
        return sendJson(res, 429, { error: "尝试次数过多，请 5 分钟后再试" });
      }
      const body = await readBody(req);
      if (!verifyPassword(body.password)) {
        loginAttempts.set(clientIp, [...(loginAttempts.get(clientIp) || []), Date.now()]);
        return sendJson(res, 401, { error: "管理员密码不正确" });
      }
      loginAttempts.delete(clientIp);
      const token = createSession();
      return sendJson(res, 200, listPayload(true), { "Set-Cookie": sessionCookie(token) });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      sessions.delete(sessionToken(req));
      return sendJson(res, 200, listPayload(false), { "Set-Cookie": sessionCookie("", 0) });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/password") {
      requireAdmin(req);
      const body = await readBody(req);
      if (!verifyPassword(body.currentPassword)) {
        return sendJson(res, 400, { error: "当前密码不正确" });
      }
      setAdminPassword(String(body.newPassword || ""), false);
      sessions.clear();
      const token = createSession();
      return sendJson(res, 200, listPayload(true), { "Set-Cookie": sessionCookie(token) });
    }

    requireAdmin(req);

    if (req.method === "POST" && url.pathname === "/api/boxes") {
      const body = await readBody(req);
      const data = readData();
      const box = buildBox(body);
      data.boxes ||= [];
      data.boxes.push(box);
      writeData(data);
      return sendJson(res, 200, listPayload(true));
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
      return sendJson(res, 200, listPayload(true));
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
      return sendJson(res, 200, listPayload(true));
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
        return sendJson(res, 200, listPayload(true));
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
        return sendJson(res, 200, listPayload(true));
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
        return sendJson(res, 200, listPayload(true));
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
  ensureAuthFile();
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

if (process.argv.includes("--set-password-stdin")) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    setAdminPassword(input.replace(/[\r\n]+$/, ""), true);
    console.log("管理员临时密码已设置");
  });
} else {
  startServer();
}
