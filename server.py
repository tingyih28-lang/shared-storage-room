from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import json
import os
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "storage.json"
PORT = int(os.environ.get("PORT", "4173"))


def ensure_data_file():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text(json.dumps({"version": 1, "items": [], "logs": []}, ensure_ascii=False, indent=2), "utf-8")


def read_data():
    ensure_data_file()
    return json.loads(DATA_FILE.read_text("utf-8"))


def write_data(data):
    ensure_data_file()
    data["version"] = int(data.get("version", 0)) + 1
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")


def clean_text(value, max_len=120):
    return str(value or "").strip()[:max_len]


def clean_number(value):
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        number = 0
    return max(0, number)


def now():
    return datetime.now(timezone.utc).isoformat()


def add_log(data, action, item, actor, quantity, note):
    logs = data.setdefault("logs", [])
    logs.insert(0, {
        "id": str(uuid.uuid4()),
        "at": now(),
        "action": action,
        "itemId": item["id"],
        "itemName": item["name"],
        "actor": clean_text(actor, 60) or "未署名",
        "quantity": clean_number(quantity),
        "note": clean_text(note, 160)
    })
    data["logs"] = logs[:300]


def payload():
    data = read_data()
    return {
        "version": data.get("version", 1),
        "items": data.get("items", []),
        "logs": data.get("logs", [])
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def send_json(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        if urlparse(self.path).path == "/api/state":
            self.send_json(200, payload())
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/items":
                body = self.read_body()
                data = read_data()
                item = {
                    "id": str(uuid.uuid4()),
                    "name": clean_text(body.get("name")),
                    "location": clean_text(body.get("location")),
                    "quantity": clean_number(body.get("quantity")),
                    "unit": clean_text(body.get("unit"), 24) or "件",
                    "owner": clean_text(body.get("owner"), 60),
                    "note": clean_text(body.get("note"), 200),
                    "updatedAt": now()
                }
                if not item["name"] or not item["location"]:
                    self.send_json(400, {"error": "物品名称和位置不能为空"})
                    return
                data.setdefault("items", []).insert(0, item)
                add_log(data, "新增", item, body.get("actor"), item["quantity"], item["note"])
                write_data(data)
                self.send_json(200, payload())
                return

            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "items"] and parts[3] in ["take", "return"]:
                body = self.read_body()
                data = read_data()
                item = next((entry for entry in data.get("items", []) if entry["id"] == parts[2]), None)
                if not item:
                    self.send_json(404, {"error": "找不到这个物品"})
                    return
                amount = clean_number(body.get("quantity", 1))
                if amount <= 0:
                    self.send_json(400, {"error": "数量必须大于 0"})
                    return
                if parts[3] == "take" and item["quantity"] < amount:
                    self.send_json(400, {"error": "库存数量不够"})
                    return
                item["quantity"] += amount if parts[3] == "return" else -amount
                item["updatedAt"] = now()
                action = "归还/放入" if parts[3] == "return" else "领取"
                add_log(data, action, item, body.get("actor"), amount, body.get("note"))
                write_data(data)
                self.send_json(200, payload())
                return
        except Exception as error:
            self.send_json(500, {"error": str(error)})
            return
        self.send_json(404, {"error": "接口不存在"})

    def do_PUT(self):
        try:
            parts = urlparse(self.path).path.strip("/").split("/")
            if len(parts) == 3 and parts[:2] == ["api", "items"]:
                body = self.read_body()
                data = read_data()
                item = next((entry for entry in data.get("items", []) if entry["id"] == parts[2]), None)
                if not item:
                    self.send_json(404, {"error": "找不到这个物品"})
                    return
                item["name"] = clean_text(body.get("name"))
                item["location"] = clean_text(body.get("location"))
                item["quantity"] = clean_number(body.get("quantity"))
                item["unit"] = clean_text(body.get("unit"), 24) or "件"
                item["owner"] = clean_text(body.get("owner"), 60)
                item["note"] = clean_text(body.get("note"), 200)
                item["updatedAt"] = now()
                if not item["name"] or not item["location"]:
                    self.send_json(400, {"error": "物品名称和位置不能为空"})
                    return
                add_log(data, "修改", item, body.get("actor"), item["quantity"], item["note"])
                write_data(data)
                self.send_json(200, payload())
                return
        except Exception as error:
            self.send_json(500, {"error": str(error)})
            return
        self.send_json(404, {"error": "接口不存在"})

    def do_DELETE(self):
        try:
            parts = urlparse(self.path).path.strip("/").split("/")
            if len(parts) == 3 and parts[:2] == ["api", "items"]:
                body = self.read_body()
                data = read_data()
                item = next((entry for entry in data.get("items", []) if entry["id"] == parts[2]), None)
                if not item:
                    self.send_json(404, {"error": "找不到这个物品"})
                    return
                data["items"] = [entry for entry in data.get("items", []) if entry["id"] != parts[2]]
                add_log(data, "删除", item, body.get("actor"), item["quantity"], body.get("note"))
                write_data(data)
                self.send_json(200, payload())
                return
        except Exception as error:
            self.send_json(500, {"error": str(error)})
            return
        self.send_json(404, {"error": "接口不存在"})


if __name__ == "__main__":
    ensure_data_file()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"共享储物间已启动: http://localhost:{PORT}")
    print(f"局域网用户可访问: http://本机IP:{PORT}")
    server.serve_forever()
