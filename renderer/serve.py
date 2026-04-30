#!/usr/bin/env python3
# Tiny dev server for the Qt-WASM renderer build.
#
# Qt-WASM expects COEP/COOP headers so the page can host SharedArrayBuffer
# (used by Qt's WASM runtime even in singlethread mode for some paths).
# Standard `python3 -m http.server` doesn't set those, so this wrapper does.

import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
DIRECTORY = "build"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        # `no-cache` (NOT `no-store`) lets the browser cache the 31MB .wasm
        # but always revalidate before reuse. Python's SimpleHTTPRequestHandler
        # honors If-Modified-Since and returns 304 for unchanged files —
        # browser keeps the cached body, so no megabytes go over the wire on
        # every refresh. After a renderer rebuild, mtime changes and the
        # browser fetches the new body. Old setting was `no-store` which
        # forced a full re-download on every page load — felt like the
        # renderer was downloading "every time" because it literally was.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"Serving renderer at http://127.0.0.1:{PORT}/qml-renderer.html")
    httpd.serve_forever()
