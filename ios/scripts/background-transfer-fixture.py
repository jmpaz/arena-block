"""Task-local delayed transfer fixture. Binds only 127.0.0.1; never contacts a source or Are.na."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from datetime import datetime, timezone
import argparse, json, os, signal, tempfile, threading, time, uuid
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, help="Directory for endpoint and static fixture receipts")
args = parser.parse_args()
root = args.output or Path(tempfile.mkdtemp(prefix="capture-loopback-"))
root.mkdir(parents=True, exist_ok=True)
receipts = []
lock = threading.Lock()
def now(): return datetime.now(timezone.utc).isoformat()
def persist():
    (root / 'loopback-receipts.json').write_text(json.dumps({'requestCount': len(receipts), 'requests': receipts}, indent=2) + '\n')
class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def json_response(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if urlsplit(self.path).path != '/receipts': return self.json_response({'error': 'Unsupported fixture path'}, 404)
        with lock: value = {'requestCount': len(receipts), 'requests': list(receipts)}
        self.json_response(value)
    def do_POST(self):
        parts = urlsplit(self.path)
        if parts.path != '/upload': return self.json_response({'error': 'Unsupported fixture path'}, 404)
        try:
            ident = str(uuid.UUID(self.headers.get('X-Capture-Probe-ID', '')))
            length = int(self.headers.get('Content-Length', '0'))
            if length != 35: raise ValueError('Unexpected fixture body length')
            body = self.rfile.read(length)
            if body != b'Capture background transfer fixture': raise ValueError('Unexpected fixture body')
            delay = min(90, max(1, int(parse_qs(parts.query).get('delay', ['75'])[0])))
        except Exception:
            return self.json_response({'error': 'Invalid static fixture request'}, 400)
        record = {'operationID': ident, 'receivedAt': now(), 'delaySeconds': delay, 'completedAt': None, 'disconnectedAt': None}
        with lock: receipts.append(record); persist()
        try:
            # Keep the slow response active so this exercises app lifecycle, not a timeout policy.
            response = b'{"fixture":"completed"}'
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(response))); self.end_headers()
            for index in range(3):
                time.sleep(delay / 3)
                first = index * len(response) // 3; last = (index + 1) * len(response) // 3
                self.wfile.write(response[first:last]); self.wfile.flush()
            with lock: record['completedAt'] = now(); persist()
        except (BrokenPipeError, ConnectionResetError):
            with lock: record['disconnectedAt'] = now(); persist()
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
server.daemon_threads = True
port = server.server_address[1]
(root / 'loopback-server.json').write_text(json.dumps({'endpoint': f'http://127.0.0.1:{port}/upload?delay=75', 'scope': 'Static fictional loopback fixture only; no credentials or external requests.', 'startedAt': now(), 'pid': os.getpid()}, indent=2) + '\n')
print(f'Loopback fixture ready on 127.0.0.1:{port}; receipts: {root}', flush=True)
def stop(*_): raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
try: server.serve_forever()
except KeyboardInterrupt: pass
finally: server.server_close()
