import socket
from http.server import ThreadingHTTPServer

from server import Handler, PORT, ensure_data_file


class IPv6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


if __name__ == "__main__":
    ensure_data_file()
    server = IPv6Server(("::", PORT), Handler)
    print(f"共享储物间 IPv6 已启动: http://[::1]:{PORT}")
    print(f"IPv6 用户可访问: http://[你的IPv6地址]:{PORT}")
    server.serve_forever()
