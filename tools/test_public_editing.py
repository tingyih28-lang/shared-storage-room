from __future__ import annotations

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


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    port = free_port()
    with tempfile.TemporaryDirectory() as temp_dir:
        env = os.environ.copy()
        env.update({"PORT": str(port), "STORAGE_DATA_DIR": temp_dir})
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py")],
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
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
                    with urllib.request.urlopen(req, timeout=3) as response:
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

            assert state["items"] == []
            request(
                "/api/items",
                "POST",
                {"name": "缺少操作人", "category": "office", "location": "地面"},
                400,
            )

            created = request(
                "/api/items",
                "POST",
                {
                    "name": "公开协作测试物品",
                    "category": "office",
                    "location": "地面",
                    "quantity": 2,
                    "unit": "件",
                    "actor": "自动测试",
                },
            )
            item_id = created["items"][0]["id"]

            updated = request(
                f"/api/items/{item_id}",
                "PUT",
                {
                    "name": "公开协作测试物品（已修改）",
                    "category": "office",
                    "location": "银色柜子1 · 第1层",
                    "quantity": 2,
                    "unit": "件",
                    "actor": "自动测试",
                },
            )
            assert updated["items"][0]["location"] == "银色柜子1 · 第1层"

            taken = request(
                f"/api/items/{item_id}/take",
                "POST",
                {"quantity": 1, "actor": "自动测试"},
            )
            assert taken["items"][0]["quantity"] == 1

            returned = request(
                f"/api/items/{item_id}/return",
                "POST",
                {"quantity": 1, "actor": "自动测试"},
            )
            assert returned["items"][0]["quantity"] == 2

            deleted = request(
                f"/api/items/{item_id}",
                "DELETE",
                {"actor": "自动测试", "note": "测试完成"},
            )
            assert deleted["items"] == []
            assert len(deleted["logs"]) == 5
            print("PASS public editing and required actor flow")
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    main()
