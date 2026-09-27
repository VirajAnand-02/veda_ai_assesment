#!/usr/bin/env python3
"""
Gateway in front of llama-server, started by `ocr_server.py start`.

- /v1/*, /health, everything else: proxied to llama-server (HunyuanOCR), which
  listens on an internal port, so clients keep using http://host:OCR_PORT/v1.
- POST /paddle/ocr: PaddleOCR (PP-OCR via RapidOCR + ONNX Runtime, on CPU).
- GET  /paddle/health: whether PaddleOCR is loaded.

Standard library only, except PaddleOCR, which needs the packages that
`ocr_server.py setup` installs into OCR_server/.venv.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import http.client
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure:
        _reconfigure(encoding="utf-8", errors="replace")

# A page can take minutes on CPU; don't give up on llama-server before that.
UPSTREAM_TIMEOUT = 30 * 60
MAX_BODY = 64 * 1024 * 1024
HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection", "host"}

# PaddleOCR model presets (RapidOCR parameter names). Measured on this
# project's test pages (Ryzen 5 5600H, CPU):
#   v6-small  handwritten sheet 1.8 s, typed A4 page 3.2 s  (default)
#   v6-medium 6.9 s / 13.5 s, slightly cleaner text
#   v5-mobile-en 1.3 s / 3.6 s, more garbage on drawings
PADDLE_PRESETS = ("v6-tiny", "v6-small", "v6-medium", "v5-mobile-en")


def paddle_params(preset: str) -> dict:
    from rapidocr import LangDet, LangRec, ModelType, OCRVersion

    if preset.startswith("v6-"):
        size = {"v6-tiny": ModelType.TINY, "v6-small": ModelType.SMALL, "v6-medium": ModelType.MEDIUM}[preset]
        return {
            "Det.ocr_version": OCRVersion.PPOCRV6,
            "Det.model_type": size,
            "Rec.ocr_version": OCRVersion.PPOCRV6,
            "Rec.model_type": size,
        }
    if preset == "v5-mobile-en":
        return {
            "Det.ocr_version": OCRVersion.PPOCRV5,
            "Det.model_type": ModelType.MOBILE,
            "Det.lang_type": LangDet.CH,
            "Rec.ocr_version": OCRVersion.PPOCRV5,
            "Rec.model_type": ModelType.MOBILE,
            "Rec.lang_type": LangRec.EN,
        }
    raise ValueError(f"Unknown PaddleOCR preset {preset!r}. Choose one of: {', '.join(PADDLE_PRESETS)}")


class Paddle:
    """One RapidOCR engine; inference is CPU-bound, so requests take turns."""

    def __init__(self, preset: str):
        from rapidocr import RapidOCR

        self.preset = preset
        self.engine = RapidOCR(params={**paddle_params(preset), "Global.log_level": "error"})
        self.lock = threading.Lock()

    def warm_up(self) -> None:
        import numpy as np

        blank = np.full((64, 256, 3), 255, dtype=np.uint8)
        with self.lock:
            self.engine(blank)

    def read(self, image_bytes: bytes) -> dict:
        import cv2
        import numpy as np

        image = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("The image could not be decoded (send a JPEG or PNG).")
        height, width = image.shape[:2]
        started = time.perf_counter()
        with self.lock:
            result = self.engine(image)
        elapsed = time.perf_counter() - started

        lines = []
        boxes = result.boxes if result.boxes is not None else []
        for polygon, text, score in zip(boxes, result.txts or (), result.scores or ()):
            xs = [float(point[0]) for point in polygon]
            ys = [float(point[1]) for point in polygon]
            box = [
                round(max(0.0, min(xs)) / width * 1000, 1),
                round(max(0.0, min(ys)) / height * 1000, 1),
                round(min(float(width), max(xs)) / width * 1000, 1),
                round(min(float(height), max(ys)) / height * 1000, 1),
            ]
            if str(text).strip():
                lines.append({"text": str(text).strip(), "box": box, "score": round(float(score), 3)})
        return {
            "model": f"PaddleOCR {self.preset} (RapidOCR)",
            "lines": lines,
            "width": width,
            "height": height,
            "durationMs": round(elapsed * 1000),
        }


def decode_image(value: str) -> bytes:
    if value.startswith("data:"):
        value = value.split(",", 1)[1] if "," in value else ""
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("`image` must be a base64 string or a data: URL.") from None


class Handler(BaseHTTPRequestHandler):
    server_version = "HunyuanOCR-gateway/1.0"
    protocol_version = "HTTP/1.1"

    # Filled in by main().
    upstream: urllib.parse.SplitResult
    api_key: str = ""
    paddle: Paddle | None = None
    paddle_error: str | None = None

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        if os.environ.get("OCR_GATEWAY_LOG"):
            super().log_message(format, *args)

    # -- routing ------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/paddle/health":
            return self.paddle_health()
        self.proxy()

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/paddle/ocr":
            return self.paddle_ocr()
        self.proxy()

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = lambda self: self.proxy()  # noqa: E731

    # -- PaddleOCR ------------------------------------------------------------

    def authorized(self) -> bool:
        if not self.api_key:
            return True
        if self.headers.get("Authorization", "") == f"Bearer {self.api_key}":
            return True
        self.send_json(401, {"error": "Invalid or missing API key."})
        return False

    def paddle_health(self) -> None:
        if not self.authorized():
            return
        if self.paddle:
            self.send_json(200, {"ready": True, "model": f"PaddleOCR {self.paddle.preset} (RapidOCR)"})
        else:
            self.send_json(503, {"ready": False, "error": self.paddle_error or "PaddleOCR is turned off (OCR_PADDLE=off)."})

    def paddle_ocr(self) -> None:
        if not self.authorized():
            return
        if not self.paddle:
            self.send_json(503, {"error": self.paddle_error or "PaddleOCR is turned off (OCR_PADDLE=off)."})
            return
        body = self.read_body()
        if body is None:
            return
        try:
            payload = json.loads(body or b"{}")
            image = payload.get("image") if isinstance(payload, dict) else None
            if not isinstance(image, str) or not image:
                raise ValueError("Send JSON {\"image\": \"<base64 or data URL>\"}.")
            result = self.paddle.read(decode_image(image))
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        except Exception as error:  # noqa: BLE001 - report instead of dropping the connection
            self.send_json(500, {"error": f"PaddleOCR failed: {error}"})
            return
        self.send_json(200, result)

    # -- proxy to llama-server -------------------------------------------------

    def proxy(self) -> None:
        body = self.read_body() if self.command in ("POST", "PUT", "PATCH") else b""
        if body is None:
            return
        headers = {key: value for key, value in self.headers.items() if key.lower() not in HOP_BY_HOP}
        headers["Host"] = self.upstream.netloc
        connection = http.client.HTTPConnection(
            self.upstream.hostname or "127.0.0.1", self.upstream.port, timeout=UPSTREAM_TIMEOUT
        )
        try:
            connection.request(self.command, self.path, body=body or None, headers=headers)
            response = connection.getresponse()
        except OSError as error:
            connection.close()
            self.send_json(502, {"error": f"HunyuanOCR (llama-server) is not reachable: {error}"})
            return

        try:
            self.send_response(response.status, response.reason)
            length = response.getheader("Content-Length")
            for key, value in response.getheaders():
                if key.lower() not in HOP_BY_HOP:
                    self.send_header(key, value)
            if length is None:
                # Streamed (e.g. SSE): pass it through, then close.
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            if self.command != "HEAD":
                while chunk := response.read1(64 * 1024) if hasattr(response, "read1") else response.read(64 * 1024):
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        finally:
            connection.close()

    # -- helpers -----------------------------------------------------------------

    def read_body(self) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.send_json(413, {"error": "Request body missing or too large."})
            return None
        return self.rfile.read(length) if length else b""

    def send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    parser = argparse.ArgumentParser(description="Gateway: llama-server proxy + PaddleOCR route.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--upstream", default="http://127.0.0.1:8091", help="llama-server base URL")
    parser.add_argument("--paddle-model", default="v6-small", help=f"{', '.join(PADDLE_PRESETS)} or 'off'")
    parser.add_argument("--warm-up-only", action="store_true", help="load PaddleOCR (downloading its models) and exit")
    arguments = parser.parse_args()

    if arguments.paddle_model != "off":
        try:
            Handler.paddle = Paddle(arguments.paddle_model)
            Handler.paddle.warm_up()
            print(f"PaddleOCR ready ({arguments.paddle_model})", flush=True)
        except Exception as error:  # noqa: BLE001
            Handler.paddle_error = f"PaddleOCR could not be loaded: {error}"
            print(Handler.paddle_error, flush=True)
            if arguments.warm_up_only:
                return 1
    if arguments.warm_up_only:
        return 0

    Handler.upstream = urllib.parse.urlsplit(arguments.upstream)
    Handler.api_key = os.environ.get("OCR_API_KEY", "").strip()
    server = ThreadingHTTPServer((arguments.host, arguments.port), Handler)
    server.daemon_threads = True
    print(f"Gateway listening on http://{arguments.host}:{arguments.port} -> {arguments.upstream}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
