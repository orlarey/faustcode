#!/usr/bin/env python3
# serve.py — local development server with no-cache headers.
#
# Module imports are aggressively cached by browsers, which makes
# iterating on the webapp painful unless the server explicitly tells
# the browser not to cache. This script is a thin wrapper around
# Python's SimpleHTTPRequestHandler that bolts on no-store/no-cache
# headers and serves the repo root.
#
# Usage :
#   ./scripts/serve.py            # http://localhost:8080
#   ./scripts/serve.py 8181       # custom port

import http.server
import os
import socketserver
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
os.chdir(REPO_ROOT)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


with socketserver.ThreadingTCPServer(('', PORT), NoCacheHandler) as srv:
    srv.daemon_threads = True
    print(f'faustcode dev server on http://localhost:{PORT}/webapp/')
    srv.serve_forever()
