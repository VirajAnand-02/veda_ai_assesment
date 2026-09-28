#!/usr/bin/env python3
"""
PaddleOCR server for the grading pipeline (AI_OCR_ENGINE=paddle-llm).

Installs PaddleOCR (PP-OCR via RapidOCR + ONNX Runtime, CPU) into
OCR_server/.venv and runs paddle_server.py, which serves POST /paddle/ocr.
The app finds it through PADDLE_OCR_URL (default http://127.0.0.1:8090/paddle).

This launcher needs only the standard library (Python 3.9+). Usage:

    python ocr_server.py setup     # install PaddleOCR and download its models
    python ocr_server.py start     # setup if needed, then serve
    python ocr_server.py check [page.png]   # health check (+ OCR an image)
    python ocr_server.py info      # show the resolved configuration

Configuration lives in OCR_server/.env (see .env.example); real environment
variables override it. The HunyuanOCR (llama.cpp) part that used to live here
is archived in /old_ocr.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure:
        _reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
VENV_DIR = ROOT / ".venv"
SERVER = ROOT / "paddle_server.py"

# Presets understood by paddle_server.py (keep in sync with PADDLE_PRESETS there).
PADDLE_PRESETS = ("v6-tiny", "v6-small", "v6-medium", "v5-mobile-en")
PADDLE_PACKAGES = ["rapidocr==3.9.2", "onnxruntime==1.30.0"]

DEFAULTS = {
    "OCR_HOST": "127.0.0.1",
    "OCR_PORT": "8090",
    "OCR_API_KEY": "",
    "OCR_PADDLE_MODEL": "v6-small",
}


class ConfigError(Exception):
    pass


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


@dataclass
class Config:
    host: str
    port: int
    api_key: str
    paddle_model: str

    @property
    def url(self) -> str:
        host = "127.0.0.1" if self.host in ("0.0.0.0", "::") else self.host
        return f"http://{host}:{self.port}"


def load_config() -> Config:
    values = dict(DEFAULTS)
    values.update(read_env_file(ROOT / ".env"))
    values.update({key: os.environ[key] for key in DEFAULTS if key in os.environ})

    try:
        port = int(values["OCR_PORT"])
    except ValueError:
        raise ConfigError(f"OCR_PORT must be a whole number (got {values['OCR_PORT']!r}).") from None
    model = values["OCR_PADDLE_MODEL"].strip() or DEFAULTS["OCR_PADDLE_MODEL"]
    if model not in PADDLE_PRESETS:
        raise ConfigError(f"OCR_PADDLE_MODEL must be one of {', '.join(PADDLE_PRESETS)} (got {model!r}).")
    return Config(
        host=values["OCR_HOST"].strip() or "127.0.0.1",
        port=port,
        api_key=values["OCR_API_KEY"].strip(),
        paddle_model=model,
    )


def log(message: str) -> None:
    print(message, flush=True)


def run(command: list[str]) -> None:
    result = subprocess.run(command)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command)}")


def venv_python() -> Path:
    return VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def setup(config: Config) -> Path:
    """Creates .venv with PaddleOCR and downloads the preset's models; returns its Python."""
    python = venv_python()
    ready = python.exists() and subprocess.run(
        [str(python), "-c", "import rapidocr, onnxruntime"], capture_output=True
    ).returncode == 0

    if not ready:
        log("Installing PaddleOCR (RapidOCR + ONNX Runtime) into OCR_server/.venv ...")
        free = shutil.disk_usage(ROOT).free
        if free < 600e6:
            raise RuntimeError(f"Not enough disk space in {ROOT}: need about 0.4 GB, {free / 1e9:.1f} GB free.")
        uv = shutil.which("uv")
        if uv:
            run([uv, "venv", str(VENV_DIR), "--python", sys.executable, "--allow-existing"])
            run([uv, "pip", "install", "--python", str(python), *PADDLE_PACKAGES])
        else:
            run([sys.executable, "-m", "venv", str(VENV_DIR)])
            run([str(python), "-m", "pip", "install", "--disable-pip-version-check", *PADDLE_PACKAGES])

    # Loading the engine once downloads the preset's models (~20-60 MB).
    result = subprocess.run(
        [str(python), str(SERVER), "--warm-up-only", "--paddle-model", config.paddle_model],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"PaddleOCR could not be set up:\n{(result.stdout + result.stderr)[-1500:]}")
    log(f"  [ok] PaddleOCR {config.paddle_model}")
    return python


def request_json(config: Config, path: str, payload: dict | None = None, timeout: float = 5) -> tuple[int | None, str]:
    headers = {"Content-Type": "application/json"}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    data = json.dumps(payload).encode() if payload is not None else None
    try:
        request = urllib.request.Request(f"{config.url}{path}", data=data, headers=headers)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as error:
        return None, str(error)


def port_in_use(port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        process.terminate()
    else:
        process.send_signal(signal.SIGINT)
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def start(config: Config) -> int:
    python = setup(config)
    if port_in_use(config.port):
        log(f"Something is already listening on port {config.port}. Stop it or set OCR_PORT.")
        return 1

    log("")
    log(f"Starting PaddleOCR at {config.url}/paddle/ocr  (CPU, {config.paddle_model})")
    log("The app uses it with AI_OCR_ENGINE=paddle-llm; set in the project's .env.local if not the default:")
    log(f"  PADDLE_OCR_URL={config.url}/paddle")
    if config.api_key:
        log("  PADDLE_OCR_API_KEY=<the value of OCR_API_KEY>")
    log("")

    server = subprocess.Popen(
        [str(python), str(SERVER), "--host", config.host, "--port", str(config.port), "--paddle-model", config.paddle_model],
        env={**os.environ, "OCR_API_KEY": config.api_key},
    )
    try:
        announced = False
        while server.poll() is None:
            if not announced and request_json(config, "/paddle/health", timeout=2)[0] == 200:
                log(f"\n>>> PaddleOCR is ready: {config.url}/paddle  (Ctrl+C to stop)\n")
                announced = True
            time.sleep(1)
        log(f"\nThe server stopped (exit code {server.returncode}).")
        return server.returncode or 1
    except KeyboardInterrupt:
        log("\nStopping PaddleOCR...")
        stop_process(server)
        return 0


def check(config: Config, image_path: str | None) -> int:
    status, body = request_json(config, "/paddle/health")
    if status != 200:
        log(f"FAIL  PaddleOCR not ready at {config.url}/paddle ({status or 'unreachable'}: {body[:200]})")
        log("      Start it with: python ocr_server.py start")
        return 1
    log(f"OK    PaddleOCR ready: {json.loads(body).get('model')}")
    if not image_path:
        log("      Pass an image to run a real request: python ocr_server.py check page.png")
        return 0

    path = Path(image_path)
    if not path.exists():
        log(f"FAIL  {image_path} not found")
        return 1
    started = time.time()
    status, body = request_json(
        config, "/paddle/ocr", {"image": base64.b64encode(path.read_bytes()).decode()}, timeout=600
    )
    if status != 200:
        log(f"FAIL  PaddleOCR returned {status}: {body[:300]}")
        return 1
    result = json.loads(body)
    lines = result.get("lines", [])
    log(f"OK    {len(lines)} text pieces in {time.time() - started:.1f}s (model time {result.get('durationMs')} ms)")
    for item in lines[:12]:
        log(f"      {item['box']}  {item['text']}")
    if len(lines) > 12:
        log(f"      ... {len(lines) - 12} more")
    return 0 if lines else 1


def info(config: Config) -> int:
    rows = [
        ("url", f"{config.url}/paddle"),
        ("model", config.paddle_model),
        ("installed", "yes" if venv_python().exists() else "no (run: python ocr_server.py setup)"),
        ("api key", "set" if config.api_key else "none"),
    ]
    for key, value in rows:
        log(f"{key:>10}  {value}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="PaddleOCR server for the grading pipeline (/paddle/ocr).")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("setup", help="install PaddleOCR and download its models")
    commands.add_parser("start", help="start the server (runs setup first if needed)")
    check_parser = commands.add_parser("check", help="check a running server; optionally OCR an image")
    check_parser.add_argument("image", nargs="?", help="PNG/JPEG page to read")
    commands.add_parser("info", help="show the resolved configuration")
    arguments = parser.parse_args()

    try:
        config = load_config()
        if arguments.command == "setup":
            setup(config)
            log("Setup complete. Start the server with: python ocr_server.py start")
            return 0
        if arguments.command == "start":
            return start(config)
        if arguments.command == "check":
            return check(config, arguments.image)
        return info(config)
    except ConfigError as error:
        log(f"Configuration error: {error}")
        return 2
    except (RuntimeError, urllib.error.URLError) as error:
        log(f"Error: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
