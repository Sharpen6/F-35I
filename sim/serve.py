#!/usr/bin/env python3
"""Local web server for the F-35I Adir flight sim.

    python serve.py              serve this folder on http://127.0.0.1:8035/
    python serve.py --open       ... and open the sim in the default browser
    python serve.py --port 9000  another port (if the port is taken the next free one is used)

Serves the folder this file is in, whatever the current directory is, on 127.0.0.1 only
(nothing is reachable from other machines). Sends correct MIME types on every platform
(Windows' registry often maps .js to text/plain, which browsers refuse for ES modules),
and tells the browser not to cache the page and its scripts, so an updated sim is always
picked up; the large data files (terrain, aircraft) are revalidated instead of re-sent.
Plain Python 3.8+ standard library, so Blender's bundled Python works too.
"""

import argparse
import errno
import http.server
import os
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8035

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.ktx2': 'image/ktx2',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.hdr': 'application/octet-stream',
    '.exr': 'application/octet-stream',
    '.woff2': 'font/woff2',
}
# the page and its code: never cached (edits show up on reload)
NO_STORE = {'.html', '.htm', '.js', '.mjs', '.css', '.map', ''}


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'   # keep-alive: the sim fetches ~1,000 files at start
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **MIME)
    verbose = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext) or super().guess_type(path)

    def end_headers(self):
        ext = os.path.splitext(self.path.split('?', 1)[0])[1].lower()
        if ext in NO_STORE or self.path.endswith('/'):
            self.send_header('Cache-Control', 'no-store, must-revalidate')
        else:
            # data: the browser may keep it but asks first (cheap 304s on localhost)
            self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.verbose:
            super().log_message(fmt, *args)

    def log_error(self, fmt, *args):
        # send_error() logs ("code %d, message %s", code, msg): show 404s (missing files) always
        if self.verbose or (args and args[0] == 404):
            sys.stderr.write('%s - %s %s\n' % (self.address_string(), fmt % args, self.path))

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass  # the browser cancelled a request (page reload, tab closed)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # on Windows reuse lets two servers share a port

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def make_server(port, tries=20):
    last = None
    for p in range(port, port + tries):
        try:
            return Server(('127.0.0.1', p), Handler), p
        except OSError as e:
            last = e
            if e.errno in (errno.EADDRINUSE, getattr(errno, 'WSAEADDRINUSE', -1), errno.EACCES, 10048, 10013):
                continue
            raise
    raise SystemExit('No free port in %d-%d (%s)' % (port, port + tries - 1, last))


def check_data():
    """Warn early when the generated data is missing (the page would show it too)."""
    missing = []
    for rel in ('data/terrain/manifest.json', 'data/aircraft/f35i_rig.json', 'data/aircraft/f35i.glb'):
        if not os.path.exists(os.path.join(ROOT, rel)):
            missing.append(rel)
    return missing


def main():
    ap = argparse.ArgumentParser(description='Serve the F-35I flight sim on 127.0.0.1.')
    ap.add_argument('--port', type=int, default=DEFAULT_PORT, help='port (default %d)' % DEFAULT_PORT)
    ap.add_argument('--open', action='store_true', help='open the sim in the default web browser')
    ap.add_argument('--verbose', action='store_true', help='log every request')
    ap.add_argument('--page', default='index.html', help='page to open with --open (default index.html)')
    args = ap.parse_args()

    Handler.verbose = args.verbose
    server, port = make_server(args.port)
    url = 'http://127.0.0.1:%d/%s' % (port, args.page.lstrip('/'))
    if port != args.port:
        print('Port %d is busy, using %d instead.' % (args.port, port))
    print('F-35I Adir flight sim')
    print('  serving  %s' % ROOT)
    print('  open     %s' % url)
    missing = check_data()
    if missing:
        print('  WARNING: generated data missing: %s' % ', '.join(missing))
        print('           (sim/tools/terrain and sim/tools/aircraft build it; or try %s?stubs=1)' % url)
    print('Close this window or press Ctrl+C to stop the server.')
    sys.stdout.flush()

    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print('\nStopped.')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
