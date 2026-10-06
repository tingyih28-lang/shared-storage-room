from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import socket
import sys
import threading
import time
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = Path(os.environ.get("STORAGE_DATA_DIR", ROOT / "data"))
DATA_FILE = DATA_DIR / "storage.json"
AUTH_FILE = DATA_DIR / "auth.json"
PORT = int(os.environ.get("PORT", "4173"))
PASSWORD_ITERATIONS = 310_000
SESSION_TTL_SECONDS = 8 * 60 * 60
LOGIN_WINDOW_SECONDS = 5 * 60
LOGIN_ATTEMPT_LIMIT = 6
SESSION_COOKIE = "storage_admin_session"
SESSIONS = {}
LOGIN_ATTEMPTS = {}
AUTH_LOCK = threading.Lock()

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


class AuthError(Exception):
    def __init__(self, message="请先登录管理员账户", status=401):
        super().__init__(message)
        self.status = status


def ensure_data_file():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text(
            json.dumps({"version": 1, "items": [], "logs": []}, ensure_ascii=False, indent=2),
            "utf-8",
        )


def password_digest(password, salt, iterations=PASSWORD_ITERATIONS):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)


def set_admin_password(password, must_change=False):
    if len(password) < 10:
        raise ValueError("管理员密码至少需要 10 个字符")
    if len(password) > 128:
        raise ValueError("管理员密码不能超过 128 个字符")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    salt = secrets.token_bytes(16)
    digest = password_digest(password, salt)
    record = {
        "salt": base64.b64encode(salt).decode("ascii"),
        "hash": base64.b64encode(digest).decode("ascii"),
        "iterations": PASSWORD_ITERATIONS,
        "mustChange": bool(must_change),
        "updatedAt": now(),
    }
    AUTH_FILE.write_text(json.dumps(record, ensure_ascii=False, indent=2), "utf-8")
    os.chmod(AUTH_FILE, 0o600)


def ensure_auth_file():
    if AUTH_FILE.exists():
        return
    temporary_password = os.environ.get("INITIAL_ADMIN_PASSWORD") or secrets.token_urlsafe(12)
    set_admin_password(temporary_password, must_change=True)
    print(f"管理员临时密码: {temporary_password}", flush=True)


def read_auth():
    ensure_auth_file()
    return json.loads(AUTH_FILE.read_text("utf-8"))


def verify_password(password):
    try:
        record = read_auth()
        salt = base64.b64decode(record["salt"])
        expected = base64.b64decode(record["hash"])
        iterations = int(record.get("iterations", PASSWORD_ITERATIONS))
        actual = password_digest(str(password or ""), salt, iterations)
        return hmac.compare_digest(actual, expected)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False


def create_session():
    token = secrets.token_urlsafe(32)
    expires_at = time.time() + SESSION_TTL_SECONDS
    with AUTH_LOCK:
        now_ts = time.time()
        expired = [key for key, expiry in SESSIONS.items() if expiry <= now_ts]
        for key in expired:
            SESSIONS.pop(key, None)
        SESSIONS[token] = expires_at
    return token


def revoke_session(token):
    if not token:
        return
    with AUTH_LOCK:
        SESSIONS.pop(token, None)


def revoke_all_sessions():
    with AUTH_LOCK:
        SESSIONS.clear()


def session_is_valid(token):
    if not token:
        return False
    with AUTH_LOCK:
        expires_at = SESSIONS.get(token, 0)
        if expires_at <= time.time():
            SESSIONS.pop(token, None)
            return False
        SESSIONS[token] = time.time() + SESSION_TTL_SECONDS
        return True


def login_allowed(client_ip):
    with AUTH_LOCK:
        cutoff = time.time() - LOGIN_WINDOW_SECONDS
        attempts = [stamp for stamp in LOGIN_ATTEMPTS.get(client_ip, []) if stamp > cutoff]
        LOGIN_ATTEMPTS[client_ip] = attempts
        return len(attempts) < LOGIN_ATTEMPT_LIMIT


def record_login_failure(client_ip):
    with AUTH_LOCK:
        LOGIN_ATTEMPTS.setdefault(client_ip, []).append(time.time())


def clear_login_failures(client_ip):
    with AUTH_LOCK:
        LOGIN_ATTEMPTS.pop(client_ip, None)


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


def payload(authenticated=False):
    data = read_data()
    auth = read_auth()
    return {
        "version": data.get("version", 1),
        "items": [normalize_item(item) for item in data.get("items", [])],
        "logs": data.get("logs", []),
        "boxes": data.get("boxes", []),
        "auth": {
            "authenticated": bool(authenticated),
            "mustChange": bool(authenticated and auth.get("mustChange")),
        },
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

    def read_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else ""

    def is_authenticated(self):
        return session_is_valid(self.session_token())

    def require_admin(self):
        if not self.is_authenticated():
            raise AuthError()

    def session_cookie(self, token, max_age=SESSION_TTL_SECONDS):
        return (
            f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; "
            f"Max-Age={max_age}"
        )

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ["/api/state", "/api/auth/status"]:
            self.send_json(200, payload(self.is_authenticated()))
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/auth/login":
                client_ip = self.client_address[0]
                if not login_allowed(client_ip):
                    raise AuthError("尝试次数过多，请 5 分钟后再试", 429)
                body = self.read_body()
                if not verify_password(body.get("password")):
                    record_login_failure(client_ip)
                    raise AuthError("管理员密码不正确", 401)
                clear_login_failures(client_ip)
                token = create_session()
                self.send_json(
                    200,
                    payload(True),
                    {"Set-Cookie": self.session_cookie(token)},
                )
                return

            if path == "/api/auth/logout":
                revoke_session(self.session_token())
                self.send_json(
                    200,
                    payload(False),
                    {"Set-Cookie": self.session_cookie("", 0)},
                )
                return

            if path == "/api/auth/password":
                self.require_admin()
                body = self.read_body()
                if not verify_password(body.get("currentPassword")):
                    raise ValueError("当前密码不正确")
                new_password = str(body.get("newPassword") or "")
                set_admin_password(new_password, must_change=False)
                revoke_all_sessions()
                token = create_session()
                self.send_json(
                    200,
                    payload(True),
                    {"Set-Cookie": self.session_cookie(token)},
                )
                return

            self.require_admin()

            if path == "/api/boxes":
                body = self.read_body()
                data = read_data()
                box = build_box(body)
                data.setdefault("boxes", []).append(box)
                write_data(data)
                self.send_json(200, payload(True))
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
                self.send_json(200, payload(True))
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
                self.send_json(200, payload(True))
                return
        except AuthError as error:
            self.send_json(error.status, {"error": str(error)})
            return
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        except Exception as error:
            self.send_json(500, {"error": str(error)})
            return
        self.send_json(404, {"error": "接口不存在"})

    def do_PUT(self):
        try:
            self.require_admin()
            parts = urlparse(self.path).path.strip("/").split("/")
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
                self.send_json(200, payload(True))
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
                self.send_json(200, payload(True))
                return
        except AuthError as error:
            self.send_json(error.status, {"error": str(error)})
            return
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        except Exception as error:
            self.send_json(500, {"error": str(error)})
            return
        self.send_json(404, {"error": "接口不存在"})

    def do_DELETE(self):
        try:
            self.require_admin()
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
                self.send_json(200, payload(True))
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
                self.send_json(200, payload(True))
                return
        except AuthError as error:
            self.send_json(error.status, {"error": str(error)})
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
    if "--set-password-stdin" in sys.argv:
        set_admin_password(sys.stdin.readline().rstrip("\r\n"), must_change=True)
        print("管理员临时密码已设置")
        raise SystemExit(0)
    ensure_auth_file()
    server = DualStackServer(("::", PORT), Handler)
    print(f"共享储物间已启动: http://localhost:{PORT}")
    print(f"IPv4 用户可访问: http://本机IPv4:{PORT}")
    print(f"IPv6 用户可访问: http://[本机IPv6]:{PORT}")
    server.serve_forever()
