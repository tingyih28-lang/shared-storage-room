from server import DualStackServer, Handler, PORT, ensure_data_file


if __name__ == "__main__":
    ensure_data_file()
    server = DualStackServer(("::", PORT), Handler)
    print(f"共享储物间 IPv4/IPv6 已启动: http://[::1]:{PORT}")
    server.serve_forever()
