from __future__ import annotations

import base64
import json
import mimetypes
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
OUTPUT = Path(r"D:\LeStoreDownload\爱心社物资管理-离线单机版.html")


def data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def build_local_api(seed: dict) -> str:
    seed_json = json.dumps(seed, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return rf"""
(() => {{
  const STORAGE_KEY = "love-club-storage-offline-v1";
  const INITIAL_DATA = {seed_json};
  const SHELVES = {{
    "黑色柜子1": ["第1层", "第2层", "第3层"],
    "黑色柜子2": ["第1层", "第2层", "第3层", "第4层"],
    "银色柜子1": ["第1层", "第2层", "第3层", "第4层"],
    "银色柜子2": ["第1层", "第2层", "第3层"],
    "银色柜子3": ["第1层", "第2层", "第3层"],
    "银色柜子4": ["第1层", "第2层", "第3层", "第4层"],
    "木柜（左）": ["整体"],
    "木柜（右）": ["整体"],
    "地面": ["无层数"]
  }};

  function clone(value) {{
    return JSON.parse(JSON.stringify(value));
  }}

  function loadData() {{
    try {{
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    }} catch (error) {{
      console.warn("读取本机数据失败", error);
    }}
    const initial = clone(INITIAL_DATA);
    initial.boxes ||= [];
    try {{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    }} catch (error) {{
      console.warn("初始化本机数据失败", error);
    }}
    return initial;
  }}

  function saveData(data) {{
    data.version = Number(data.version || 0) + 1;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }}

  function cleanText(value, maxLength = 120) {{
    return String(value ?? "").trim().slice(0, maxLength);
  }}

  function cleanNumber(value) {{
    const number = Math.floor(Number(value));
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  }}

  function cleanCategory(value) {{
    return value === "keeper" ? "keeper" : "office";
  }}

  function requireActor(value) {{
    const name = cleanText(value, 60);
    if (!name) throw new Error("请填写操作人");
    return name;
  }}

  function uuid() {{
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${{Date.now().toString(36)}}-${{Math.random().toString(36).slice(2)}}`;
  }}

  function normalizeItem(item) {{
    item.category ||= "office";
    item.keeper ||= "";
    item.location ||= "";
    item.lastActor ||= "";
    return item;
  }}

  function payload(data = loadData()) {{
    data.items ||= [];
    data.logs ||= [];
    data.boxes ||= [];
    data.items.forEach(normalizeItem);
    return clone({{
      version: data.version || 1,
      items: data.items,
      logs: data.logs,
      boxes: data.boxes
    }});
  }}

  function addLog(data, action, item, actor, quantity, note) {{
    const cleanActor = requireActor(actor);
    data.logs ||= [];
    data.logs.unshift({{
      id: uuid(),
      at: new Date().toISOString(),
      action,
      itemId: item.id,
      itemName: item.name,
      category: cleanCategory(item.category),
      actor: cleanActor,
      quantity: cleanNumber(quantity),
      note: cleanText(note, 160)
    }});
    item.lastActor = cleanActor;
    data.logs = data.logs.slice(0, 500);
  }}

  function buildBox(body, id = uuid(), createdAt = new Date().toISOString()) {{
    const cabinet = cleanText(body.cabinet, 40);
    const shelf = cleanText(body.shelf, 20);
    const documentUrl = cleanText(body.documentUrl, 500);
    const box = {{
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
      updatedAt: new Date().toISOString()
    }};
    if (!box.label) throw new Error("请填写储物箱名称或编号");
    if (!SHELVES[cabinet]) throw new Error("请选择有效的柜子或区域");
    if (!SHELVES[cabinet].includes(shelf)) throw new Error("请选择有效的层数");
    if (!box.position) throw new Error("请填写储物箱的具体位置");
    if (!box.department) throw new Error("请填写所属部组");
    try {{
      const parsed = new URL(documentUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    }} catch {{
      throw new Error("请填写有效的物资清单文档链接");
    }}
    return box;
  }}

  function jsonResponse(status, body) {{
    return new Response(JSON.stringify(body), {{
      status,
      headers: {{ "Content-Type": "application/json; charset=utf-8" }}
    }});
  }}

  async function localApi(input, options = {{}}) {{
    const rawUrl = String(input);
    const path = rawUrl.startsWith("/api/") || rawUrl === "/api/state"
      ? rawUrl
      : new URL(rawUrl, location.href).pathname;
    const method = String(options.method || "GET").toUpperCase();
    let body = {{}};
    if (options.body) body = JSON.parse(options.body);

    try {{
      if (method === "GET" && path === "/api/state") {{
        return jsonResponse(200, payload());
      }}

      const data = loadData();
      data.items ||= [];
      data.logs ||= [];
      data.boxes ||= [];

      if (method === "POST" && path === "/api/boxes") {{
        data.boxes.push(buildBox(body));
        saveData(data);
        return jsonResponse(200, payload(data));
      }}

      if (method === "POST" && path === "/api/items") {{
        const category = cleanCategory(body.category);
        const item = {{
          id: uuid(),
          category,
          name: cleanText(body.name),
          location: category === "office" ? cleanText(body.location) : "",
          keeper: category === "keeper" ? cleanText(body.keeper, 60) : "",
          quantity: cleanNumber(body.quantity),
          unit: cleanText(body.unit, 24) || "件",
          owner: cleanText(body.owner, 60),
          note: cleanText(body.note, 200),
          lastActor: "",
          updatedAt: new Date().toISOString()
        }};
        if (!item.name) throw new Error("物品名称不能为空");
        if (category === "office" && !item.location) throw new Error("请选择位置");
        if (category === "keeper" && !item.keeper) throw new Error("请填写骨干名字");
        data.items.unshift(item);
        addLog(data, "新增", item, body.actor, item.quantity, item.note);
        saveData(data);
        return jsonResponse(200, payload(data));
      }}

      let match = path.match(/^\/api\/items\/([^/]+)\/(take|return)$/);
      if (method === "POST" && match) {{
        const item = data.items.find(entry => entry.id === match[1]);
        if (!item) return jsonResponse(404, {{ error: "找不到这个物品" }});
        const amount = cleanNumber(body.quantity ?? 1);
        if (amount <= 0) throw new Error("数量必须大于 0");
        if (match[2] === "take" && item.quantity < amount) throw new Error("库存数量不够");
        item.quantity += match[2] === "return" ? amount : -amount;
        item.updatedAt = new Date().toISOString();
        addLog(data, match[2] === "return" ? "归还/放入" : "领取", item, body.actor, amount, body.note);
        saveData(data);
        return jsonResponse(200, payload(data));
      }}

      match = path.match(/^\/api\/boxes\/([^/]+)$/);
      if (match) {{
        const index = data.boxes.findIndex(entry => entry.id === match[1]);
        if (index < 0) return jsonResponse(404, {{ error: "找不到这个储物箱" }});
        if (method === "PUT") {{
          const current = data.boxes[index];
          data.boxes[index] = buildBox(body, current.id, current.createdAt);
        }} else if (method === "DELETE") {{
          requireActor(body.actor);
          data.boxes.splice(index, 1);
        }} else {{
          return jsonResponse(404, {{ error: "接口不存在" }});
        }}
        saveData(data);
        return jsonResponse(200, payload(data));
      }}

      match = path.match(/^\/api\/items\/([^/]+)$/);
      if (match) {{
        const item = data.items.find(entry => entry.id === match[1]);
        if (!item) return jsonResponse(404, {{ error: "找不到这个物品" }});
        normalizeItem(item);
        if (method === "PUT") {{
          const category = cleanCategory(body.category ?? item.category);
          item.category = category;
          item.name = cleanText(body.name);
          item.location = category === "office" ? cleanText(body.location) : "";
          item.keeper = category === "keeper" ? cleanText(body.keeper, 60) : "";
          item.quantity = cleanNumber(body.quantity);
          item.unit = cleanText(body.unit, 24) || "件";
          item.owner = cleanText(body.owner, 60);
          item.note = cleanText(body.note, 200);
          item.updatedAt = new Date().toISOString();
          if (!item.name) throw new Error("物品名称不能为空");
          if (category === "office" && !item.location) throw new Error("请选择位置");
          if (category === "keeper" && !item.keeper) throw new Error("请填写骨干名字");
          addLog(data, "修改", item, body.actor, item.quantity, item.note);
        }} else if (method === "DELETE") {{
          addLog(data, "删除", item, body.actor, item.quantity, body.note);
          data.items = data.items.filter(entry => entry.id !== item.id);
        }} else {{
          return jsonResponse(404, {{ error: "接口不存在" }});
        }}
        saveData(data);
        return jsonResponse(200, payload(data));
      }}
    }} catch (error) {{
      return jsonResponse(400, {{ error: error.message || "操作失败" }});
    }}
    return jsonResponse(404, {{ error: "接口不存在" }});
  }}

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {{
    const url = String(input);
    if (url.startsWith("/api/") || url === "/api/state") return localApi(input, options);
    return nativeFetch(input, options);
  }};
}})();
"""


def build() -> None:
    html = (PUBLIC / "index.html").read_text("utf-8")
    html = re.sub(
        r'\s*<a class="portal-card" href="\.\/community-inventory\/">.*?<\/a>',
        "",
        html,
        count=1,
        flags=re.DOTALL,
    )
    css = (PUBLIC / "styles.css").read_text("utf-8")
    app = (PUBLIC / "app.js").read_text("utf-8")
    seed = json.loads((ROOT / "data" / "storage.json").read_text("utf-8"))

    assets = {}
    for path in (PUBLIC / "assets").iterdir():
        if path.is_file():
            assets[f"./assets/{path.name}"] = data_uri(path)

    for source, encoded in assets.items():
        html = html.replace(source, encoded)
        css = css.replace(source, encoded)
        app = app.replace(source, encoded)

    html = re.sub(
        r'<link rel="stylesheet" href="\.\/styles\.css\?v=[^"]+">',
        f"<style>\n{css}\n</style>",
        html,
        count=1,
    )
    html = html.replace(
        '<aside id="fileWarning" class="file-warning" hidden>',
        '<aside id="fileWarning" class="file-warning">',
    )
    html = re.sub(
        r'当前是直接打开的 HTML 预览，不能保存或同步数据。请启动服务器后访问\s*<strong>[^<]+</strong>。',
        '这是离线单机版：数据会保存在当前浏览器中，不会自动同步到其他人的电脑。',
        html,
        count=1,
    )

    app = re.sub(
        r'\s*if \(location\.protocol === "file:"\) \{\s*throw new Error\("[^"]+"\);\s*\}',
        "",
        app,
        count=1,
    )
    app = app.replace("已同步，版本", "已保存到本机，版本")
    app = app.replace("同步失败，稍后会自动重试", "读取本机数据失败")
    app = re.sub(
        r'  if \(location\.protocol === "file:"\) \{.*?\n  \} else \{\n    refresh\(\);\n    setInterval\(\(\) => refresh\(true\), 3000\);\n  \}',
        '  refresh();\n  setInterval(() => refresh(true), 1000);',
        app,
        count=1,
        flags=re.DOTALL,
    )

    scripts = f"<script>\n{build_local_api(seed)}\n</script>\n<script>\n{app}\n</script>"
    html = re.sub(
        r'<script src="\.\/app\.js\?v=[^"]+"></script>',
        lambda _: scripts,
        html,
        count=1,
    )
    html = html.replace("<title>爱心社物资管理</title>", "<title>爱心社物资管理（离线单机版）</title>")

    OUTPUT.write_text(html, "utf-8")
    print(f"Generated: {OUTPUT}")
    print(f"Size: {OUTPUT.stat().st_size} bytes")


if __name__ == "__main__":
    build()
