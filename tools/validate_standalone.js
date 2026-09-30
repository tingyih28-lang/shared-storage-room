const fs = require("fs");
const vm = require("vm");
const { webcrypto } = require("crypto");

const file = "D:\\LeStoreDownload\\爱心社物资管理-离线单机版.html";
const html = fs.readFileSync(file, "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

if (scripts.length !== 2) throw new Error(`Expected 2 inline scripts, found ${scripts.length}`);
for (const script of scripts) new Function(script);

const externalReferences = [...html.matchAll(/(?:src|href)="(?!data:|#|https?:|mailto:|tel:|javascript:)([^"]+)"/g)];
if (externalReferences.length) {
  throw new Error(`External local references remain: ${externalReferences.map(match => match[1]).join(", ")}`);
}

const memory = new Map();
const localStorage = {
  getItem(key) {
    return memory.has(key) ? memory.get(key) : null;
  },
  setItem(key, value) {
    memory.set(key, String(value));
  }
};
const context = {
  console,
  crypto: webcrypto,
  localStorage,
  location: { href: "file:///D:/LeStoreDownload/offline.html" },
  Response,
  URL
};
context.window = { fetch: async () => new Response("not found", { status: 404 }) };
vm.createContext(context);
vm.runInContext(scripts[0], context);

async function request(path, method = "GET", body) {
  const response = await context.window.fetch(path, {
    method,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `${method} ${path} failed`);
  return data;
}

(async () => {
  const initial = await request("/api/state");
  if (initial.items.length !== 10 || initial.logs.length !== 59 || initial.boxes.length !== 2) {
    throw new Error("Initial data snapshot does not match the current project data");
  }

  const created = await request("/api/items", "POST", {
    category: "keeper",
    name: "离线测试物品",
    keeper: "测试骨干",
    quantity: 2,
    unit: "件",
    owner: "测试部组",
    note: "自动验证",
    actor: "Codex 自动验证"
  });
  const item = created.items.find(entry => entry.name === "离线测试物品");
  if (!item || item.quantity !== 2) throw new Error("Offline item creation failed");

  const taken = await request(`/api/items/${item.id}/take`, "POST", {
    quantity: 1,
    note: "自动验证领取",
    actor: "Codex 自动验证"
  });
  if (taken.items.find(entry => entry.id === item.id)?.quantity !== 1) {
    throw new Error("Offline quantity operation failed");
  }

  const removed = await request(`/api/items/${item.id}`, "DELETE", {
    actor: "Codex 自动验证",
    note: "删除自动验证数据"
  });
  if (removed.items.some(entry => entry.id === item.id)) throw new Error("Offline item deletion failed");

  console.log(`PASS scripts=${scripts.length} items=${initial.items.length} logs=${initial.logs.length} boxes=${initial.boxes.length}`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
