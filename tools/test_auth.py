from __future__ import annotations

import http.cookiejar
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INITIAL_PASSWORD = "Temp-Admin-2026!"
NEW_PASSWORD = "New-Admin-Password-2026!"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    port = free_port()
    with tempfile.TemporaryDirectory() as temp_dir:
        env = os.environ.copy()
        env.update(
            {
                "PORT": str(port),
                "STORAGE_DATA_DIR": temp_dir,
                "INITIAL_ADMIN_PASSWORD": INITIAL_PASSWORD,
            }
        )
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py")],
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            jar = http.cookiejar.CookieJar()
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            base = f"http://127.0.0.1:{port}"

            def request(path, method="GET", body=None, expected=200):
                raw = None if body is None else json.dumps(body).encode("utf-8")
                req = urllib.request.Request(
                    base + path,
                    data=raw,
                    method=method,
                    headers={"Content-Type": "application/json"},
                )
                try:
                    with opener.open(req, timeout=3) as response:
                        status = response.status
                        payload = json.loads(response.read().decode("utf-8"))
                except urllib.error.HTTPError as error:
                    status = error.code
                    payload = json.loads(error.read().decode("utf-8"))
                assert status == expected, (path, status, payload)
                return payload

            deadline = time.time() + 8
            while True:
                try:
                    state = request("/api/state")
                    break
                except (OSError, urllib.error.URLError):
                    if time.time() >= deadline:
                        raise
                    time.sleep(0.1)

            assert state["auth"] == {"authenticated": False, "mustChange": False}
            request(
                "/api/items",
                "POST",
                {"name": "未授权测试", "category": "office", "location": "地面"},
                401,
            )
            request("/api/auth/login", "POST", {"password": "wrong-password"}, 401)
            logged_in = request("/api/auth/login", "POST", {"password": INITIAL_PASSWORD})
            assert logged_in["auth"] == {"authenticated": True, "mustChange": True}

            created = request(
                "/api/items",
                "POST",
                {
                    "name": "权限测试物品",
                    "category": "office",
                    "location": "地面",
                    "quantity": 1,
                    "unit": "件",
                    "actor": "自动测试",
                },
            )
            assert len(created["items"]) == 1

            changed = request(
                "/api/auth/password",
                "POST",
                {"currentPassword": INITIAL_PASSWORD, "newPassword": NEW_PASSWORD},
            )
            assert changed["auth"] == {"authenticated": True, "mustChange": False}
            request("/api/auth/logout", "POST", {})
            request("/api/auth/login", "POST", {"password": INITIAL_PASSWORD}, 401)
            relogged = request("/api/auth/login", "POST", {"password": NEW_PASSWORD})
            assert relogged["auth"]["authenticated"] is True
            assert len(relogged["items"]) == 1
            print("PASS auth, permissions, password change, and session flow")
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    main()
