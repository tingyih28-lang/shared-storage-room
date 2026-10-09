from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import base64
import json
import os
import socket
import threading
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = Path(os.environ.get("STORAGE_DATA_DIR", ROOT / "data"))
DATA_FILE = DATA_DIR / "storage.json"
PORT = int(os.environ.get("PORT", "4173"))
DATA_LOCK = threading.RLock()

STORAGE_SHELVES = {
    "黑色柜子1": ["第1层", "第2层", "第3层"],
    "黑色柜子2": ["第1层", "第2层", "第3层", "第4层"],
    "银色柜子1": ["第1层", "第2层", "第3层", "第4层"],
    "银色柜子2": ["第1层", "第2层", "第3层"],
    "银色柜子3": ["第1层", "第2层", "第3层"],
    "银色柜子4": ["第1层", "第2层", "第3层", "第4层"],
    "木柜（左）": ["整体"],
    "木柜（右）": ["整体"],
    "地面": ["无层数"],
}


class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def ensure_data_file():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text(
            json.dumps({"version": 1, "items": [], "logs": []}, ensure_ascii=False, indent=2),
            "utf-8",
        )


def serialized_mutation(method):
    def wrapped(self, *args, **kwargs):
        with DATA_LOCK:
            return method(self, *args, **kwargs)
    return wrapped


def read_data():
    ensure_data_file()
    with DATA_LOCK:
        return json.loads(DATA_FILE.read_text("utf-8"))


def write_data(data):
    ensure_data_file()
    with DATA_LOCK:
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


def clean_category(value):
    return "keeper" if value == "keeper" else "office"


def now():
    return datetime.now(timezone.utc).isoformat()


def normalize_item(item):
    item.setdefault("category", "office")
    item.setdefault("keeper", "")
    item.setdefault("location", "")
    item.setdefault("lastActor", "")
    return item


def require_actor(value):
    actor = clean_text(value, 60)
    if not actor:
        raise ValueError("请填写操作人")
    return actor


def build_box(body, box_id=None, created_at=None):
    cabinet = clean_text(body.get("cabinet"), 40)
    shelf = clean_text(body.get("shelf"), 20)
    document_url = clean_text(body.get("documentUrl"), 500)
    parsed_url = urlparse(document_url)

    box = {
        "id": box_id or str(uuid.uuid4()),
        "label": clean_text(body.get("label"), 80),
        "cabinet": cabinet,
        "shelf": shelf,
        "position": clean_text(body.get("position"), 100),
        "department": clean_text(body.get("department"), 80),
        "activity": clean_text(body.get("activity"), 100),
        "documentUrl": document_url,
        "updatedBy": require_actor(body.get("actor")),
        "createdAt": created_at or now(),
        "updatedAt": now(),
    }

    if not box["label"]:
        raise ValueError("请填写储物箱名称或编号")
    if cabinet not in STORAGE_SHELVES:
        raise ValueError("请选择有效的柜子或区域")
    if shelf not in STORAGE_SHELVES[cabinet]:
        raise ValueError("请选择有效的层数")
    if not box["position"]:
        raise ValueError("请填写储物箱的具体位置")
    if not box["department"]:
        raise ValueError("请填写所属部组")
    if parsed_url.scheme not in ["http", "https"] or not parsed_url.netloc:
        raise ValueError("请填写有效的物资清单文档链接")
    return box


def add_log(data, action, item, actor, quantity, note):
    clean_actor = require_actor(actor)

    logs = data.setdefault("logs", [])
    logs.insert(
        0,
        {
            "id": str(uuid.uuid4()),
            "at": now(),
            "action": action,
            "itemId": item["id"],
            "itemName": item["name"],
            "category": clean_category(item.get("category")),
            "actor": clean_actor,
            "quantity": clean_number(quantity),
            "note": clean_text(note, 160),
        },
    )
    item["lastActor"] = clean_actor
    data["logs"] = logs[:500]


def payload():
    data = read_data()
    return {
        "version": data.get("version", 1),
        "items": [normalize_item(item) for item in data.get("items", [])],
        "logs": data.get("logs", []),
        "boxes": data.get("boxes", []),
    }


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def end_headers(self):
        if not urlparse(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, body, headers=None):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_body(self, max_bytes=3_000_000):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        if length > max_bytes:
            raise ValueError("图片或表单内容太大，请换一张较小的图片")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed_path = urlparse(self.path)
        path = parsed_path.path
        if path == "/api/state":
            self.send_json(200, payload())
            return
        if path == "/api/found-items":
            data = read_data()
            items = data.get("foundItems", [])
            if "summary=1" in parsed_path.query:
                items = [{key: value for key, value in item.items() if key != "imageData"} for item in items]
            self.send_json(200, {"version": data.get("version", 1), "items": items})
            return
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "found-items"]:
            data = read_data()
            item = next((entry for entry in data.get("foundItems", []) if entry["id"] == parts[2]), None)
            if not item:
                self.send_json(404, {"error": "找不到这件物资"})
            else:
                self.send_json(200, {"item": item})
            return
        super().do_GET()

    @serialized_mutation
    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/found-items":
                body = self.read_body()
                name = clean_text(body.get("name"), 100)
                features = clean_text(body.get("features"), 1000)
                uses = clean_text(body.get("uses"), 500)
                location = clean_text(body.get("location"), 160)
                image_data = str(body.get("imageData") or "")
                if not name:
                    raise ValueError("请填写物品名称")
                if not location:
                    raise ValueError("请填写物品位置")
                if not features:
                    raise ValueError("请填写物品特征")
                if not image_data.startswith(("data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,")):
                    raise ValueError("请选择 JPG、PNG 或 WebP 图片")
                if len(image_data) > 2_100_000:
                    raise ValueError("图片太大，请重新选择或压缩后上传")
                try:
                    encoded_image = image_data.split(",", 1)[1]
                    base64.b64decode(encoded_image, validate=True)
                except (IndexError, ValueError):
                    raise ValueError("图片数据无效，请重新选择图片")
                entry = {
                    "id": str(uuid.uuid4()),
                    "name": name,
                    "features": features,
                    "uses": uses,
                    "location": location,
                    "imageData": image_data,
                    "department": "",
                    "activity": "",
                    "uploadedAt": now(),
                    "updatedAt": now(),
                }
                with DATA_LOCK:
                    data = read_data()
                    data.setdefault("foundItems", []).insert(0, entry)
                    write_data(data)
                self.send_json(200, {"id": entry["id"], "version": data["version"]})
                return

            if path == "/api/boxes":
                body = self.read_body()
                data = read_data()
                box = build_box(body)
                data.setdefault("boxes", []).append(box)
                write_data(data)
                self.send_json(200, payload())
                return

            if path == "/api/items":
                body = self.read_body()
                data = read_data()
                category = clean_category(body.get("category"))
                item = {
                    "id": str(uuid.uuid4()),
                    "category": category,
                    "name": clean_text(body.get("name")),
                    "location": clean_text(body.get("location")) if category == "office" else "",
                    "keeper": clean_text(body.get("keeper"), 60) if category == "keeper" else "",
                    "quantity": clean_number(body.get("quantity")),
                    "unit": clean_text(body.get("unit"), 24) or "件",
                    "owner": clean_text(body.get("owner"), 60),
                    "note": clean_text(body.get("note"), 200),
                    "lastActor": "",
                    "updatedAt": now(),
                }
                if not item["name"]:
                    self.send_json(400, {"error": "物品名称不能为空"})
                    return
                if category == "office" and not item["location"]:
                    self.send_json(400, {"error": "请选择位置"})
                    return
                if category == "keeper" and not item["keeper"]:
                    self.send_json(400, {"error": "请填写骨干名字"})
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
                normalize_item(item)
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
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        except Exception as error:
            self.send_json(500, {"error": str(error)})
            return
        self.send_json(404, {"error": "接口不存在"})

    @serialized_mutation
    def do_PUT(self):
        try:
            parts = urlparse(self.path).path.strip("/").split("/")
            if len(parts) == 3 and parts[:2] == ["api", "found-items"]:
                body = self.read_body()
                with DATA_LOCK:
                    data = read_data()
                    items = data.setdefault("foundItems", [])
                    item = next((entry for entry in items if entry["id"] == parts[2]), None)
                    if not item:
                        self.send_json(404, {"error": "找不到这件物资"})
                        return
                    item["department"] = clean_text(body.get("department"), 100)
                    item["activity"] = clean_text(body.get("activity"), 120)
                    item["updatedAt"] = now()
                    write_data(data)
                self.send_json(200, {"id": item["id"], "version": data["version"]})
                return

            if len(parts) == 3 and parts[:2] == ["api", "boxes"]:
                body = self.read_body()
                data = read_data()
                boxes = data.get("boxes", [])
                index = next((i for i, entry in enumerate(boxes) if entry["id"] == parts[2]), None)
                if index is None:
                    self.send_json(404, {"error": "找不到这个储物箱"})
                    return
                current = boxes[index]
                boxes[index] = build_box(body, current["id"], current.get("createdAt"))
                data["boxes"] = boxes
                write_data(data)
                self.send_json(200, payload())
                return

            if len(parts) == 3 and parts[:2] == ["api", "items"]:
                body = self.read_body()
                data = read_data()
                item = next((entry for entry in data.get("items", []) if entry["id"] == parts[2]), None)
                if not item:
                    self.send_json(404, {"error": "找不到这个物品"})
                    return
                category = clean_category(body.get("category", item.get("category")))
                item["category"] = category
                item["name"] = clean_text(body.get("name"))
                item["location"] = clean_text(body.get("location")) if category == "office" else ""
                item["keeper"] = clean_text(body.get("keeper"), 60) if category == "keeper" else ""
                item["quantity"] = clean_number(body.get("quantity"))
                item["unit"] = clean_text(body.get("unit"), 24) or "件"
                item["owner"] = clean_text(body.get("owner"), 60)
                item["note"] = clean_text(body.get("note"), 200)
                item["updatedAt"] = now()
                if not item["name"]:
                    self.send_json(400, {"error": "物品名称不能为空"})
                    return
                if category == "office" and not item["location"]:
                    self.send_json(400, {"error": "请选择位置"})
                    return
                if category == "keeper" and not item["keeper"]:
                    self.send_json(400, {"error": "请填写骨干名字"})
                    return
                add_log(data, "修改", item, body.get("actor"), item["quantity"], item["note"])
                write_data(data)
                self.send_json(200, payload())
                return
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        except Exception as error:
            self.send_json(500, {"error": str(error)})
            return
        self.send_json(404, {"error": "接口不存在"})

    @serialized_mutation
    def do_DELETE(self):
        try:
            parts = urlparse(self.path).path.strip("/").split("/")
            if len(parts) == 3 and parts[:2] == ["api", "boxes"]:
                body = self.read_body()
                require_actor(body.get("actor"))
                data = read_data()
                boxes = data.get("boxes", [])
                if not any(entry["id"] == parts[2] for entry in boxes):
                    self.send_json(404, {"error": "找不到这个储物箱"})
                    return
                data["boxes"] = [entry for entry in boxes if entry["id"] != parts[2]]
                write_data(data)
                self.send_json(200, payload())
                return

            if len(parts) == 3 and parts[:2] == ["api", "items"]:
                body = self.read_body()
                data = read_data()
                item = next((entry for entry in data.get("items", []) if entry["id"] == parts[2]), None)
                if not item:
                    self.send_json(404, {"error": "找不到这个物品"})
                    return
                normalize_item(item)
                add_log(data, "删除", item, body.get("actor"), item["quantity"], body.get("note"))
                data["items"] = [entry for entry in data.get("items", []) if entry["id"] != parts[2]]
                write_data(data)
                self.send_json(200, payload())
                return
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        except Exception as error:
            self.send_json(500, {"error": str(error)})
            return
        self.send_json(404, {"error": "接口不存在"})


if __name__ == "__main__":
    ensure_data_file()
    server = DualStackServer(("::", PORT), Handler)
    print(f"共享储物间已启动: http://localhost:{PORT}")
    print(f"IPv4 用户可访问: http://本机IPv4:{PORT}")
    print(f"IPv6 用户可访问: http://[本机IPv6]:{PORT}")
    server.serve_forever()
