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
DEFAULT_LAYOUT = {name: len(shelves) if shelves != ["整体"] and shelves != ["无层数"] else (0 if shelves == ["无层数"] else 1) for name, shelves in STORAGE_SHELVES.items()}


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


def migrate_data(data):
    changed = False
    if not isinstance(data.get("layout"), dict):
        data["layout"] = DEFAULT_LAYOUT.copy()
        changed = True
    for key in ["items", "logs", "boxes"]:
        if not isinstance(data.get(key), list):
            data[key] = []
            changed = True
    items = data["items"]
    had_found_items = "foundItems" in data
    found_items = data.pop("foundItems", [])
    if not isinstance(found_items, list):
        found_items = []
    existing_ids = {item.get("id") for item in items}
    for found in found_items:
        if found.get("id") in existing_ids:
            continue
        items.insert(0, {
            **found,
            "category": "office",
            "quantity": 1,
            "unit": "件",
            "owner": "",
            "note": "",
            "lastActor": "",
            "boxId": found.get("boxId", ""),
            "location": found.get("location", "待整理"),
            "foundItem": True,
        })
        changed = True
    changed = changed or had_found_items
    return changed


def serialized_mutation(method):
    def wrapped(self, *args, **kwargs):
        with DATA_LOCK:
            return method(self, *args, **kwargs)
    return wrapped


def read_data():
    ensure_data_file()
    with DATA_LOCK:
        data = json.loads(DATA_FILE.read_text("utf-8"))
        if migrate_data(data):
            data["version"] = int(data.get("version", 0)) + 1
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
        return data


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


def layout_shelves(data):
    result = {}
    layout = {**DEFAULT_LAYOUT, **data.get("layout", {})}
    for cabinet, count in layout.items():
        if cabinet not in STORAGE_SHELVES:
            continue
        if cabinet == "地面":
            result[cabinet] = ["无层数"]
        elif cabinet in ["木柜（左）", "木柜（右）"]:
            result[cabinet] = ["整体"]
        else:
            result[cabinet] = [f"第{i + 1}层" for i in range(max(0, min(12, int(count))))]
    return result


def build_box(body, data, box_id=None, created_at=None):
    cabinet = clean_text(body.get("cabinet"), 40)
    shelf = clean_text(body.get("shelf"), 20)
    document_url = clean_text(body.get("documentUrl"), 500)
    parsed_url = urlparse(document_url)

    box = {
        "id": box_id or str(uuid.uuid4()),
        "label": clean_text(body.get("label"), 80),
        "kind": "袋子" if body.get("kind") == "bag" else "箱子",
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
    shelves = layout_shelves(data)
    if cabinet not in shelves:
        raise ValueError("请选择有效的柜子或区域")
    if shelf not in shelves[cabinet]:
        raise ValueError("请选择有效的层数")
    if not box["position"]:
        raise ValueError("请填写储物箱的具体位置")
    if document_url and (parsed_url.scheme not in ["http", "https"] or not parsed_url.netloc):
        raise ValueError("物资清单链接格式不正确")
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
    boxes = data.get("boxes", [])
    box_map = {box["id"]: box for box in boxes}
    items = []
    for item in data.get("items", []):
        normalized = normalize_item(item.copy())
        normalized["hasImage"] = bool(normalized.get("imageData"))
        normalized.pop("imageData", None)
        box = box_map.get(normalized.get("boxId"))
        if box:
            normalized["location"] = f"{box['cabinet']} · {box['shelf']} · {box['label']}"
        items.append(normalized)
    return {
        "version": data.get("version", 1),
        "items": items,
        "logs": data.get("logs", []),
        "boxes": boxes,
        "layout": {**DEFAULT_LAYOUT, **data.get("layout", {})},
    }


def office_items(data):
    return [item for item in data.get("items", []) if clean_category(item.get("category")) == "office"]


def find_box(data, box_id):
    if not box_id:
        return None
    return next((box for box in data.get("boxes", []) if box.get("id") == box_id), None)


def item_location(data, box_id, fallback=""):
    box = find_box(data, box_id)
    if box:
        return f"{box['cabinet']} · {box['shelf']} · {box['label']}"
    return clean_text(fallback, 160)


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
            items = office_items(data)
            if "summary=1" in parsed_path.query:
                items = [{key: value for key, value in item.items() if key != "imageData"} for item in items]
            self.send_json(200, {"version": data.get("version", 1), "items": items, "boxes": data.get("boxes", []), "layout": {**DEFAULT_LAYOUT, **data.get("layout", {})}})
            return
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "found-items"]:
            data = read_data()
            item = next((entry for entry in office_items(data) if entry["id"] == parts[2]), None)
            if not item:
                self.send_json(404, {"error": "找不到这件物资"})
            else:
                self.send_json(200, {"item": item})
            return
        if len(parts) == 3 and parts[:2] == ["api", "items"]:
            data = read_data()
            item = next((entry for entry in data.get("items", []) if entry["id"] == parts[2]), None)
            if not item:
                self.send_json(404, {"error": "找不到这个物品"})
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
                box_id = clean_text(body.get("boxId"), 64)
                location = item_location(read_data(), box_id, body.get("location"))
                image_data = str(body.get("imageData") or "")
                if not name:
                    raise ValueError("请填写物品名称")
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
                with DATA_LOCK:
                    data = read_data()
                    box = find_box(data, box_id)
                    if box_id and not box:
                        raise ValueError("所选箱袋已不存在，请重新选择")
                    entry = {
                    "id": str(uuid.uuid4()),
                    "category": "office",
                    "foundItem": True,
                    "name": name,
                    "features": features,
                    "uses": uses,
                    "boxId": box_id,
                    "location": location or "待整理",
                    "imageData": image_data,
                    "department": "",
                    "activity": "",
                    "quantity": 1,
                    "unit": "件",
                    "owner": "",
                    "note": "",
                    "lastActor": "",
                    "uploadedAt": now(),
                    "updatedAt": now(),
                    }
                    data.setdefault("items", []).insert(0, entry)
                    add_log(data, "新增待认领物资", entry, body.get("actor") or "共同编辑者", 1, location or "待整理")
                    write_data(data)
                self.send_json(200, {"id": entry["id"], "version": data["version"]})
                return

            if path == "/api/boxes":
                body = self.read_body()
                data = read_data()
                box = build_box(body, data)
                data.setdefault("boxes", []).append(box)
                write_data(data)
                self.send_json(200, payload())
                return

            if path == "/api/layout":
                body = self.read_body()
                data = read_data()
                require_actor(body.get("actor"))
                layout = {**DEFAULT_LAYOUT, **data.get("layout", {})}
                for cabinet, value in body.get("layout", {}).items():
                    if cabinet not in STORAGE_SHELVES:
                        raise ValueError("包含无效的柜子")
                    count = clean_number(value)
                    if cabinet in ["木柜（左）", "木柜（右）", "地面"]:
                        count = DEFAULT_LAYOUT[cabinet]
                    if count > 12:
                        raise ValueError("每个柜子最多设置 12 层")
                    valid_shelves = layout_shelves({"layout": {**layout, cabinet: count}})[cabinet]
                    if any(box.get("cabinet") == cabinet and box.get("shelf") not in valid_shelves for box in data.get("boxes", [])):
                        raise ValueError(f"{cabinet} 减层会影响已有箱袋，请先移动箱袋")
                    layout[cabinet] = count
                data["layout"] = layout
                write_data(data)
                self.send_json(200, payload())
                return

            if path == "/api/items":
                body = self.read_body()
                data = read_data()
                category = clean_category(body.get("category"))
                box_id = clean_text(body.get("boxId"), 64) if category == "office" else ""
                if box_id and not find_box(data, box_id):
                    raise ValueError("所选箱袋已不存在，请重新选择")
                item = {
                    "id": str(uuid.uuid4()),
                    "category": category,
                    "name": clean_text(body.get("name")),
                    "boxId": box_id,
                    "location": item_location(data, box_id, body.get("location")) if category == "office" else "",
                    "features": clean_text(body.get("features"), 1000),
                    "uses": clean_text(body.get("uses"), 500),
                    "department": clean_text(body.get("department"), 100),
                    "activity": clean_text(body.get("activity"), 120),
                    "imageData": str(body.get("imageData") or ""),
                    "uploadedAt": now(),
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
                if category == "office" and (not item["boxId"] or not item["features"] or not item["imageData"]):
                    self.send_json(400, {"error": "社办物品需要选择箱袋并填写特征、上传照片"})
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
            if parts == ["api", "layout"]:
                body = self.read_body()
                data = read_data()
                require_actor(body.get("actor"))
                layout = {**DEFAULT_LAYOUT, **data.get("layout", {})}
                for cabinet, value in body.get("layout", {}).items():
                    if cabinet not in STORAGE_SHELVES:
                        raise ValueError("包含无效的柜子")
                    count = clean_number(value)
                    if cabinet in ["木柜（左）", "木柜（右）", "地面"]:
                        count = DEFAULT_LAYOUT[cabinet]
                    if count > 12:
                        raise ValueError("每个柜子最多设置 12 层")
                    valid_shelves = layout_shelves({"layout": {**layout, cabinet: count}})[cabinet]
                    if any(box.get("cabinet") == cabinet and box.get("shelf") not in valid_shelves for box in data.get("boxes", [])):
                        raise ValueError(f"{cabinet} 减层会影响已有箱袋，请先移动箱袋")
                    layout[cabinet] = count
                data["layout"] = layout
                write_data(data)
                self.send_json(200, payload())
                return

            if len(parts) == 3 and parts[:2] == ["api", "found-items"]:
                body = self.read_body()
                with DATA_LOCK:
                    data = read_data()
                    items = office_items(data)
                    item = next((entry for entry in items if entry["id"] == parts[2]), None)
                    if not item:
                        self.send_json(404, {"error": "找不到这件物资"})
                        return
                    name = clean_text(body.get("name", item.get("name")), 100)
                    features = clean_text(body.get("features", item.get("features")), 1000)
                    uses = clean_text(body.get("uses", item.get("uses")), 500)
                    image_data = body.get("imageData", item.get("imageData", ""))
                    if not name or not features:
                        raise ValueError("物品名称和特征不能为空")
                    if image_data and (not image_data.startswith(("data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,")) or len(image_data) > 2_100_000):
                        raise ValueError("图片格式无效或文件太大")
                    box_id = clean_text(body.get("boxId", item.get("boxId")), 64)
                    if box_id and not find_box(data, box_id):
                        raise ValueError("所选箱袋已不存在，请重新选择")
                    item["name"] = name
                    item["features"] = features
                    item["uses"] = uses
                    item["imageData"] = image_data
                    item["department"] = clean_text(body.get("department"), 100)
                    item["activity"] = clean_text(body.get("activity"), 120)
                    item["boxId"] = box_id
                    item["location"] = item_location(data, box_id, "待整理") or "待整理"
                    item["updatedAt"] = now()
                    add_log(data, "更新物资资料", item, body.get("actor") or "共同编辑者", item.get("quantity", 1), "待认领页面")
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
                boxes[index] = build_box(body, data, current["id"], current.get("createdAt"))
                data["boxes"] = boxes
                for item in data.get("items", []):
                    if item.get("boxId") == current["id"]:
                        item["location"] = item_location(data, current["id"])
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
                item["boxId"] = clean_text(body.get("boxId", item.get("boxId")), 64) if category == "office" else ""
                if item["boxId"] and not find_box(data, item["boxId"]):
                    raise ValueError("所选箱袋已不存在，请重新选择")
                item["location"] = item_location(data, item["boxId"], body.get("location")) if category == "office" else ""
                item["keeper"] = clean_text(body.get("keeper"), 60) if category == "keeper" else ""
                item["features"] = clean_text(body.get("features", item.get("features")), 1000)
                item["uses"] = clean_text(body.get("uses", item.get("uses")), 500)
                item["department"] = clean_text(body.get("department", item.get("department")), 100)
                item["activity"] = clean_text(body.get("activity", item.get("activity")), 120)
                if "imageData" in body:
                    image_data = str(body.get("imageData") or "")
                    if image_data and (not image_data.startswith(("data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,")) or len(image_data) > 2_100_000):
                        raise ValueError("图片格式无效或文件太大")
                    item["imageData"] = image_data
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
                if any(item.get("boxId") == parts[2] for item in data.get("items", [])):
                    self.send_json(400, {"error": "这个箱袋仍关联着物资，请先把物资移到其他位置"})
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
