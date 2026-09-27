#!/usr/bin/env python3
"""
HunyuanOCR server.

Downloads a prebuilt llama.cpp release and the HunyuanOCR-1.5 GGUF weights,
then runs llama.cpp's `llama-server`, which exposes an OpenAI-compatible API
(POST /v1/chat/completions with images). The Next.js app talks to it through
HUNYUAN_OCR_BASE_URL.

Standard library only (Python 3.9+). Usage:

    python ocr_server.py setup     # download + verify binaries and model
    python ocr_server.py start     # setup if needed, then serve
    python ocr_server.py check [image.png]   # health check (+ OCR an image)
    python ocr_server.py info      # show the resolved configuration

Configuration lives in OCR_server/.env (see .env.example); real environment
variables override it. OCR_DEVICE=cpu (default) or gpu selects where the model
runs.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

# Windows consoles default to a legacy code page; model output contains Chinese
# and other non-ASCII text, so write UTF-8 (and never crash on printing).
for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure:
        _reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
BIN_DIR = ROOT / "bin"
MODELS_DIR = ROOT / "models"
VENV_DIR = ROOT / ".venv"  # PaddleOCR's Python packages (the rest of this script needs none)

# PaddleOCR presets understood by gateway.py (keep in sync with PADDLE_PRESETS there).
PADDLE_PRESETS = ("v6-tiny", "v6-small", "v6-medium", "v5-mobile-en")
PADDLE_PACKAGES = ["rapidocr==3.9.2", "onnxruntime==1.30.0"]

# The official "spotting_json" prompt from Tencent-Hunyuan/HunyuanOCR
# (inference/utils/tasks.py); the app sends the same text.
SPOTTING_PROMPT = (
    "检测并识别图中所有的文字行，请按从上到下、从左到右的阅读顺序进行识别。 "
    "输出格式为 JSON 数组，每个元素必须包含："
    '"box": [xmin, ymin, xmax, ymax]（坐标需归一化到 [0, 1000] 范围内）；'
    '"text": "识别出的文字内容"。 '
    "注意：请直接输出 JSON 数组，不要包含任何多余的描述性文字。"
)

DEFAULTS = {
    "OCR_DEVICE": "cpu",  # cpu | gpu
    "OCR_GPU_BACKEND": "",  # vulkan | cuda (Windows/Linux); empty = vulkan. macOS always uses Metal.
    "OCR_HOST": "127.0.0.1",
    "OCR_PORT": "8090",
    "OCR_API_KEY": "",
    "OCR_MODEL_ALIAS": "tencent/HunyuanOCR",
    "OCR_MODEL_REPO": "prithivMLmods/HunyuanOCR-1.5-GGUF-Updated",
    "OCR_MODEL_QUANT": "Q8_0",
    "OCR_MMPROJ_QUANT": "q8_0",
    "OCR_LLAMA_BUILD": "b11201",
    "OCR_CTX_SIZE": "8192",
    "OCR_MAX_TOKENS": "4096",
    "OCR_THREADS": "",
    "OCR_GPU_LAYERS": "all",
    "OCR_GPU_DEVICE": "",  # e.g. Vulkan1 or CUDA0; empty = pick the dedicated GPU automatically
    "OCR_EXTRA_ARGS": "",
    "OCR_PADDLE": "on",  # on | off: the /paddle route (PaddleOCR on CPU)
    "OCR_PADDLE_MODEL": "v6-small",  # see PADDLE_PRESETS
    "HF_TOKEN": "",
}


# ---------------------------------------------------------------------------
# Configuration


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
    device: str
    backend: str  # cpu | vulkan | cuda | metal
    host: str
    port: int
    api_key: str
    alias: str
    model_repo: str
    model_quant: str
    mmproj_quant: str
    llama_build: str
    ctx_size: int
    max_tokens: int
    threads: int | None
    gpu_layers: str
    gpu_device: str
    extra_args: list[str]
    hf_token: str
    platform_key: str
    paddle_model: str | None  # None = PaddleOCR route off

    @property
    def llama_port(self) -> int:
        """llama-server listens here (localhost only); the gateway owns `port`."""
        return self.port + 1

    @property
    def base_url(self) -> str:
        host = "127.0.0.1" if self.host in ("0.0.0.0", "::") else self.host
        return f"http://{host}:{self.port}/v1"

    @property
    def model_file(self) -> str:
        return f"HunyuanOCR.{self.model_quant}.gguf"

    @property
    def mmproj_file(self) -> str:
        return f"HunyuanOCR.mmproj-{self.mmproj_quant}.gguf"


def gpu_layers(value: str) -> str:
    """'all', 'auto' or a whole number of layers to offload in GPU mode."""
    value = value.strip().lower() or "all"
    if value in ("all", "auto") or value.isdigit():
        return value
    raise ConfigError(f"OCR_GPU_LAYERS must be 'all', 'auto' or a number (got {value!r}).")


def detect_platform() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64" if machine in ("x86_64", "amd64") else machine
    name = {"windows": "windows", "linux": "linux", "darwin": "macos"}.get(system, system)
    key = f"{name}-{arch}"
    if key not in ("windows-x64", "linux-x64", "macos-arm64"):
        raise ConfigError(f"Unsupported platform {key}. Supported: windows-x64, linux-x64, macos-arm64.")
    return key


def load_config() -> Config:
    values = dict(DEFAULTS)
    values.update(read_env_file(ROOT / ".env"))
    values.update({key: os.environ[key] for key in DEFAULTS if key in os.environ})

    def integer(key: str, minimum: int = 0) -> int:
        try:
            number = int(values[key])
        except ValueError:
            raise ConfigError(f"{key} must be a whole number (got {values[key]!r}).") from None
        if number < minimum:
            raise ConfigError(f"{key} must be at least {minimum}.")
        return number

    device = values["OCR_DEVICE"].strip().lower()
    if device not in ("cpu", "gpu"):
        raise ConfigError(f"OCR_DEVICE must be 'cpu' or 'gpu' (got {values['OCR_DEVICE']!r}).")

    platform_key = detect_platform()
    if device == "cpu":
        backend = "cpu"
    elif platform_key.startswith("macos"):
        backend = "metal"
    else:
        backend = (values["OCR_GPU_BACKEND"].strip().lower() or "vulkan")
        if backend not in ("vulkan", "cuda"):
            raise ConfigError(f"OCR_GPU_BACKEND must be 'vulkan' or 'cuda' (got {values['OCR_GPU_BACKEND']!r}).")

    paddle_switch = values["OCR_PADDLE"].strip().lower()
    if paddle_switch not in ("on", "off"):
        raise ConfigError(f"OCR_PADDLE must be 'on' or 'off' (got {values['OCR_PADDLE']!r}).")
    paddle_model = values["OCR_PADDLE_MODEL"].strip() or DEFAULTS["OCR_PADDLE_MODEL"]
    if paddle_model not in PADDLE_PRESETS:
        raise ConfigError(f"OCR_PADDLE_MODEL must be one of {', '.join(PADDLE_PRESETS)} (got {paddle_model!r}).")

    return Config(
        device=device,
        backend=backend,
        host=values["OCR_HOST"].strip() or "127.0.0.1",
        port=integer("OCR_PORT", 1),
        api_key=values["OCR_API_KEY"].strip(),
        alias=values["OCR_MODEL_ALIAS"].strip() or DEFAULTS["OCR_MODEL_ALIAS"],
        model_repo=values["OCR_MODEL_REPO"].strip(),
        model_quant=values["OCR_MODEL_QUANT"].strip(),
        mmproj_quant=values["OCR_MMPROJ_QUANT"].strip(),
        llama_build=values["OCR_LLAMA_BUILD"].strip(),
        ctx_size=integer("OCR_CTX_SIZE", 2048),
        max_tokens=integer("OCR_MAX_TOKENS", 256),
        threads=integer("OCR_THREADS", 1) if values["OCR_THREADS"].strip() else None,
        gpu_layers=gpu_layers(values["OCR_GPU_LAYERS"]),
        gpu_device=values["OCR_GPU_DEVICE"].strip(),
        extra_args=values["OCR_EXTRA_ARGS"].split(),
        hf_token=values["HF_TOKEN"].strip(),
        platform_key=platform_key,
        paddle_model=paddle_model if paddle_switch == "on" else None,
    )


# ---------------------------------------------------------------------------
# Downloads


def log(message: str) -> None:
    print(message, flush=True)


def http_json(url: str, token: str = "") -> object:
    request = urllib.request.Request(url, headers={"User-Agent": "hunyuan-ocr-server", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, destination: Path, expected_sha256: str | None, size_hint: int | None, token: str = "") -> None:
    """Streams to <file>.part, verifies the checksum, then moves into place."""
    if destination.exists() and (expected_sha256 is None or verified(destination, expected_sha256)):
        log(f"  [ok] {destination.name} (already downloaded)")
        return

    ensure_disk_space(destination.parent, size_hint)
    partial = destination.with_name(destination.name + ".part")
    headers = {"User-Agent": "hunyuan-ocr-server", **({"Authorization": f"Bearer {token}"} if token else {})}
    request = urllib.request.Request(url, headers=headers)
    started = time.time()
    with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as out:
        total = int(response.headers.get("Content-Length") or size_hint or 0)
        done = 0
        last_print = 0.0
        while chunk := response.read(1024 * 1024):
            out.write(chunk)
            done += len(chunk)
            now = time.time()
            if now - last_print > 0.5 or done == total:
                last_print = now
                speed = done / max(now - started, 1e-6) / 1e6
                percent = f"{done / total * 100:5.1f}%" if total else ""
                print(f"\r  [download] {destination.name}: {done / 1e6:7.1f} MB {percent} ({speed:.1f} MB/s)", end="", flush=True)
    print()

    if expected_sha256:
        actual = sha256_of(partial)
        if actual != expected_sha256:
            partial.unlink(missing_ok=True)
            raise RuntimeError(f"Checksum mismatch for {destination.name}: expected {expected_sha256}, got {actual}.")
    partial.replace(destination)
    if expected_sha256:
        destination.with_name(destination.name + ".sha256").write_text(expected_sha256)
    log(f"  [ok] {destination.name} verified")


def verified(path: Path, expected_sha256: str) -> bool:
    """Cheap check via a stored marker; falls back to hashing the file."""
    marker = path.with_name(path.name + ".sha256")
    if marker.exists() and marker.read_text().strip() == expected_sha256:
        return True
    if sha256_of(path) == expected_sha256:
        marker.write_text(expected_sha256)
        return True
    return False


def ensure_disk_space(folder: Path, needed: int | None) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    if not needed:
        return
    free = shutil.disk_usage(folder).free
    if free < needed * 1.1 + 200e6:
        raise RuntimeError(f"Not enough disk space in {folder}: need about {needed / 1e9:.1f} GB, {free / 1e9:.1f} GB free.")


# llama.cpp release assets per platform and backend (regex on the asset name).
ASSETS = {
    ("windows-x64", "cpu"): [r"llama-{b}-bin-win-cpu-x64\.zip"],
    ("windows-x64", "vulkan"): [r"llama-{b}-bin-win-vulkan-x64\.zip"],
    ("windows-x64", "cuda"): [r"llama-{b}-bin-win-cuda-12\.4-x64\.zip", r"cudart-llama-bin-win-cuda-12\.4-x64\.zip"],
    ("linux-x64", "cpu"): [r"llama-{b}-bin-ubuntu-x64\.tar\.gz"],
    ("linux-x64", "vulkan"): [r"llama-{b}-bin-ubuntu-vulkan-x64\.tar\.gz"],
    ("linux-x64", "cuda"): [r"llama-{b}-bin-ubuntu-cuda-12\.8-x64\.tar\.gz", r"cudart-llama-{b}-bin-ubuntu-cuda-12\.8-x64\.tar\.gz"],
    ("macos-arm64", "cpu"): [r"llama-{b}-bin-macos-arm64\.tar\.gz"],
    ("macos-arm64", "metal"): [r"llama-{b}-bin-macos-arm64\.tar\.gz"],
}


def binary_dir(config: Config) -> Path:
    # macOS uses one build for CPU and Metal.
    backend = "metal" if config.platform_key.startswith("macos") else config.backend
    return BIN_DIR / f"{config.llama_build}-{config.platform_key}-{backend}"


def find_server_binary(folder: Path) -> Path | None:
    name = "llama-server.exe" if os.name == "nt" else "llama-server"
    matches = sorted(folder.rglob(name)) if folder.exists() else []
    return matches[0] if matches else None


def ensure_binaries(config: Config) -> Path:
    folder = binary_dir(config)
    existing = find_server_binary(folder)
    if existing:
        log(f"  [ok] llama.cpp {config.llama_build} ({folder.name})")
        return existing

    log(f"Downloading llama.cpp {config.llama_build} for {config.platform_key} ({config.backend})...")
    release = http_json(f"https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{config.llama_build}")
    assets = release.get("assets", []) if isinstance(release, dict) else []
    archives = BIN_DIR / "_downloads"
    for pattern in ASSETS[(config.platform_key, "metal" if config.platform_key.startswith("macos") else config.backend)]:
        regex = re.compile(pattern.format(b=re.escape(config.llama_build)) + "$")
        asset = next((a for a in assets if regex.match(a["name"])), None)
        if not asset:
            raise RuntimeError(f"llama.cpp release {config.llama_build} has no asset matching {regex.pattern}.")
        digest = asset.get("digest") or ""
        archive = archives / asset["name"]
        download(asset["browser_download_url"], archive, digest.removeprefix("sha256:") or None, asset.get("size"))
        extract(archive, folder)
        archive.unlink()
        archive.with_name(archive.name + ".sha256").unlink(missing_ok=True)

    binary = find_server_binary(folder)
    if not binary:
        raise RuntimeError(f"llama-server was not found after extracting into {folder}.")
    if os.name != "nt":
        for tool in binary.parent.iterdir():
            if tool.is_file() and tool.name.startswith("llama"):
                tool.chmod(tool.stat().st_mode | 0o111)
    return binary


def extract(archive: Path, folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(folder)
    else:
        with tarfile.open(archive) as bundle:
            if sys.version_info >= (3, 12):
                bundle.extractall(folder, filter="data")
            else:
                bundle.extractall(folder)  # noqa: S202 - trusted archive, checksum verified


def ensure_models(config: Config) -> tuple[Path, Path]:
    tree = http_json(f"https://huggingface.co/api/models/{config.model_repo}/tree/main", config.hf_token)
    files = {item["path"]: item for item in tree if isinstance(item, dict)} if isinstance(tree, list) else {}
    paths = []
    for name in (config.model_file, config.mmproj_file):
        item = files.get(name)
        if not item:
            available = ", ".join(sorted(path for path in files if path.endswith(".gguf")))
            raise ConfigError(f"{name} is not in {config.model_repo}. Available: {available}")
        destination = MODELS_DIR / name
        url = f"https://huggingface.co/{config.model_repo}/resolve/main/{name}"
        download(url, destination, (item.get("lfs") or {}).get("oid"), item.get("size"), config.hf_token)
        paths.append(destination)
    return paths[0], paths[1]


def venv_python() -> Path:
    return VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def ensure_paddle(config: Config) -> Path:
    """Creates .venv with PaddleOCR (RapidOCR + ONNX Runtime) and downloads its models."""
    python = venv_python()
    ready = python.exists() and subprocess.run(
        [str(python), "-c", "import rapidocr, onnxruntime"], capture_output=True
    ).returncode == 0

    if not ready:
        log("Installing PaddleOCR (RapidOCR + ONNX Runtime) into OCR_server/.venv ...")
        ensure_disk_space(ROOT, 400_000_000)
        uv = shutil.which("uv")
        if uv:
            run([uv, "venv", str(VENV_DIR), "--python", sys.executable, "--allow-existing"])
            run([uv, "pip", "install", "--python", str(python), *PADDLE_PACKAGES])
        else:
            run([sys.executable, "-m", "venv", str(VENV_DIR)])
            run([str(python), "-m", "pip", "install", "--disable-pip-version-check", *PADDLE_PACKAGES])

    # Loading the engine once downloads the preset's models (~20-60 MB).
    result = subprocess.run(
        [str(python), str(ROOT / "gateway.py"), "--warm-up-only", "--paddle-model", config.paddle_model or "v6-small"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"PaddleOCR could not be set up:\n{(result.stdout + result.stderr)[-1500:]}")
    log(f"  [ok] PaddleOCR {config.paddle_model}")
    return python


def run(command: list[str]) -> None:
    result = subprocess.run(command)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command)}")


def setup(config: Config) -> tuple[Path, Path, Path, Path]:
    """Returns llama-server, the model, the vision encoder, and the Python that runs the gateway."""
    log("Checking llama.cpp and model files...")
    binary = ensure_binaries(config)
    model, mmproj = ensure_models(config)
    # Without PaddleOCR the gateway only proxies, which needs no packages.
    gateway_python = ensure_paddle(config) if config.paddle_model else Path(sys.executable)
    return binary, model, mmproj, gateway_python



# ---------------------------------------------------------------------------
# Serving


def server_args(config: Config, binary: Path, model: Path, mmproj: Path, gpu_device: str | None = None) -> list[str]:
    args = [
        str(binary),
        "--model", str(model),
        "--mmproj", str(mmproj),
        "--alias", config.alias,
        # Only the gateway talks to llama-server.
        "--host", "127.0.0.1",
        "--port", str(config.llama_port),
        "--ctx-size", str(config.ctx_size),
        "--n-predict", str(config.max_tokens),
        # One request at a time keeps memory predictable on small machines.
        "--parallel", "1",
        # Tencent's recommended sampling for HunyuanOCR (requests may override).
        "--temp", "0",
        "--repeat-penalty", "1.08",
        "--flash-attn", "auto",
        "--jinja",
        "--no-webui",
        # Each page is a different image, so the prompt cache only costs RAM.
        "--cache-ram", "0",
    ]
    if config.device == "cpu":
        # Keep everything off the GPU, including the vision encoder.
        args += ["--device", "none", "--n-gpu-layers", "0", "--no-mmproj-offload"]
    else:
        args += ["--n-gpu-layers", config.gpu_layers]
        if gpu_device:
            # The vision encoder follows --device.
            args += ["--device", gpu_device]
    if config.threads:
        args += ["--threads", str(config.threads)]
    if config.api_key:
        args += ["--api-key", config.api_key]
    return args + config.extra_args


def list_devices(binary: Path) -> list[str]:
    try:
        result = subprocess.run(
            [str(binary), "--list-devices"], capture_output=True, text=True, timeout=60, cwd=binary.parent
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    lines = (result.stdout + result.stderr).splitlines()
    return [line.strip() for line in lines if re.match(r"\s*[A-Za-z]+\d*:\s", line) and "available devices" not in line.lower()]


# Integrated graphics often report more (shared) memory than a small dedicated
# card, so prefer devices that look dedicated.
DEDICATED_GPU = re.compile(r"nvidia|geforce|rtx|quadro|tesla|radeon\s*(rx|pro)|instinct|arc\b", re.IGNORECASE)


def choose_gpu(config: Config, devices: list[str]) -> str | None:
    """Returns the llama.cpp device id to use (e.g. 'Vulkan1'), or None for llama.cpp's default."""
    ids = {line.split(":", 1)[0].strip(): line for line in devices}
    if config.gpu_device:
        if config.gpu_device not in ids:
            raise ConfigError(f"OCR_GPU_DEVICE={config.gpu_device} not found. Available: {', '.join(ids) or 'none'}.")
        return config.gpu_device
    dedicated = [device_id for device_id, line in ids.items() if DEDICATED_GPU.search(line)]
    if dedicated:
        return dedicated[0]
    return next(iter(ids), None)


def health(config: Config, timeout: float = 5) -> tuple[int | None, str]:
    url = config.base_url.removesuffix("/v1") + "/health"
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as response:
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


def paddle_health(config: Config, timeout: float = 5) -> tuple[int | None, str]:
    url = config.base_url.removesuffix("/v1") + "/paddle/health"
    headers = {"Authorization": f"Bearer {config.api_key}"} if config.api_key else {}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as error:
        return None, str(error)


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
    binary, model, mmproj, gateway_python = setup(config)

    gpu_device = None
    if config.device == "gpu":
        devices = list_devices(binary)
        if devices:
            log(f"GPU devices ({config.backend}): " + "; ".join(devices))
            gpu_device = choose_gpu(config, devices)
            if gpu_device:
                log(f"Using {gpu_device}" + ("" if config.gpu_device else " (set OCR_GPU_DEVICE to choose another)"))
        else:
            log(
                f"WARNING: the {config.backend} build found no GPU, so llama.cpp will run on the CPU. "
                "Check your GPU driver, or try OCR_GPU_BACKEND=cuda (NVIDIA) or OCR_DEVICE=cpu."
            )

    for port in (config.port, config.llama_port):
        if port_in_use(port):
            log(f"Something is already listening on port {port}. Stop it or set OCR_PORT "
                f"(the server uses OCR_PORT and OCR_PORT + 1).")
            return 1

    root_url = config.base_url.removesuffix("/v1")
    log("")
    log(f"Starting the OCR server at {root_url}")
    log(f"  HunyuanOCR  {root_url}/v1   ({config.device.upper()}, {config.backend}; {model.name} + {mmproj.name})")
    if config.paddle_model:
        log(f"  PaddleOCR   {root_url}/paddle/ocr   (CPU, {config.paddle_model})")
    log("")
    log("Point the app at it in the project's .env.local:")
    log(f"  HUNYUAN_OCR_BASE_URL={config.base_url}")
    log(f"  HUNYUAN_OCR_MODEL={config.alias}")
    if config.api_key:
        log("  HUNYUAN_OCR_API_KEY=<the value of OCR_API_KEY>")
    log("")

    llama = subprocess.Popen(server_args(config, binary, model, mmproj, gpu_device), cwd=binary.parent)
    gateway_command = [
        str(gateway_python), str(ROOT / "gateway.py"),
        "--host", config.host,
        "--port", str(config.port),
        "--upstream", f"http://127.0.0.1:{config.llama_port}",
        "--paddle-model", config.paddle_model or "off",
    ]
    gateway = subprocess.Popen(gateway_command, env={**os.environ, "OCR_API_KEY": config.api_key})
    processes = [llama, gateway]
    try:
        # Report when HunyuanOCR (through the gateway) and PaddleOCR are ready.
        announced = False
        while all(process.poll() is None for process in processes):
            if not announced:
                hunyuan_ok = health(config, timeout=2)[0] == 200
                paddle_ok = not config.paddle_model or paddle_health(config, timeout=2)[0] == 200
                if hunyuan_ok and paddle_ok:
                    log(f"\n>>> OCR server is ready: {root_url}  (Ctrl+C to stop)\n")
                    announced = True
            time.sleep(1)
        # One of them stopped: take the other down too.
        exited = next(process for process in processes if process.poll() is not None)
        log(f"\n{'llama-server' if exited is llama else 'The gateway'} stopped (exit code {exited.returncode}); shutting down.")
        for process in processes:
            stop_process(process)
        return exited.returncode or 1
    except KeyboardInterrupt:
        log("\nStopping the OCR server...")
        for process in processes:
            stop_process(process)
        return 0


# ---------------------------------------------------------------------------
# Checks


def parse_spotting(output: str) -> list[dict]:
    text = re.sub(r"```(?:json)?", "", output).strip()
    start_index, end_index = text.find("["), text.rfind("]")
    if start_index != -1 and end_index > start_index:
        try:
            items = json.loads(text[start_index : end_index + 1])
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict) and item.get("text") and item.get("box")]
        except json.JSONDecodeError:
            pass
    items = []
    for match in re.finditer(r"\{[^{}]*\}", text):
        try:
            item = json.loads(match.group(0))
        except json.JSONDecodeError:
            continue
        if item.get("text") and item.get("box"):
            items.append(item)
    return items


def check_paddle(config: Config, image_path: str | None) -> int:
    status, body = paddle_health(config)
    if status != 200:
        log(f"FAIL  PaddleOCR not ready at {config.base_url.removesuffix('/v1')}/paddle ({status or 'unreachable'}: {body[:200]})")
        return 1
    log(f"OK    PaddleOCR ready: {json.loads(body).get('model')}")
    if not image_path:
        log("      Pass an image to run a real request: python ocr_server.py check --paddle page.png")
        return 0

    path = Path(image_path)
    if not path.exists():
        log(f"FAIL  {image_path} not found")
        return 1
    headers = {"Content-Type": "application/json"}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    payload = json.dumps({"image": base64.b64encode(path.read_bytes()).decode()}).encode()
    started = time.time()
    request = urllib.request.Request(f"{config.base_url.removesuffix('/v1')}/paddle/ocr", data=payload, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        log(f"FAIL  PaddleOCR returned {error.code}: {error.read().decode('utf-8', 'replace')[:300]}")
        return 1
    lines = result.get("lines", [])
    log(f"OK    {len(lines)} text lines in {time.time() - started:.1f}s (model time {result.get('durationMs')} ms)")
    for item in lines[:12]:
        log(f"      {item['box']}  {item['text']}")
    if len(lines) > 12:
        log(f"      ... {len(lines) - 12} more")
    return 0 if lines else 1


def check(config: Config, image_path: str | None) -> int:
    status, body = health(config)
    if status != 200:
        log(f"FAIL  server not ready at {config.base_url} ({status or 'unreachable'}: {body[:200]})")
        log("      Start it with: python ocr_server.py start")
        return 1
    log(f"OK    server healthy at {config.base_url}")

    headers = {"Content-Type": "application/json"}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    try:
        request = urllib.request.Request(f"{config.base_url}/models", headers=headers)
        with urllib.request.urlopen(request, timeout=10) as response:
            models = [item.get("id") for item in json.load(response).get("data", [])]
        log(f"OK    models: {', '.join(filter(None, models))}")
    except urllib.error.HTTPError as error:
        log(f"FAIL  /v1/models returned {error.code}" + (" (check OCR_API_KEY)" if error.code == 401 else ""))
        return 1

    if not image_path:
        log("      Pass an image to run a real OCR request: python ocr_server.py check page.png")
        return 0

    path = Path(image_path)
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(path.suffix.lower())
    if not path.exists() or not mime:
        log(f"FAIL  {image_path} is not a PNG/JPEG/WebP file")
        return 1

    image_url = f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"
    payload = {
        "model": config.alias,
        "messages": [
            {"role": "system", "content": ""},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_url}},
                    {"type": "text", "text": SPOTTING_PROMPT},
                ],
            },
        ],
        "temperature": 0,
        "max_tokens": config.max_tokens,
    }
    log(f"...   running text spotting on {path.name} ({config.device.upper()}); this can take a while on CPU")
    started = time.time()
    request = urllib.request.Request(
        f"{config.base_url}/chat/completions", data=json.dumps(payload).encode(), headers=headers
    )
    try:
        with urllib.request.urlopen(request, timeout=1800) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        log(f"FAIL  OCR request returned {error.code}: {error.read().decode('utf-8', 'replace')[:300]}")
        return 1
    elapsed = time.time() - started

    choice = result["choices"][0]
    lines = parse_spotting(choice["message"].get("content") or "")
    usage = result.get("usage", {})
    speed = result.get("timings", {}).get("predicted_per_second")
    log(
        f"OK    {len(lines)} text lines in {elapsed:.1f}s "
        f"(prompt {usage.get('prompt_tokens', '?')} tokens, output {usage.get('completion_tokens', '?')} tokens"
        + (f", {speed:.1f} tok/s)" if speed else ")")
    )
    if choice.get("finish_reason") == "length":
        log("WARN  output hit the token limit (raise OCR_MAX_TOKENS)")
    for item in lines[:12]:
        log(f"      {item['box']}  {item['text']}")
    if len(lines) > 12:
        log(f"      ... {len(lines) - 12} more")
    return 0 if lines else 1


def info(config: Config) -> int:
    binary = find_server_binary(binary_dir(config))
    model_ready = (MODELS_DIR / config.model_file).exists()
    mmproj_ready = (MODELS_DIR / config.mmproj_file).exists()
    rows = [
        ("device", f"{config.device} ({config.backend})"),
        ("platform", config.platform_key),
        ("url", config.base_url),
        ("alias", config.alias),
        ("llama.cpp", f"{config.llama_build} -> {'installed' if binary else 'not downloaded'}"),
        ("model", f"{config.model_repo} / {config.model_file} -> {'downloaded' if model_ready else 'not downloaded'}"),
        ("mmproj", f"{config.mmproj_file} -> {'downloaded' if mmproj_ready else 'not downloaded'}"),
        ("context", f"{config.ctx_size} tokens, max output {config.max_tokens}"),
        ("paddleocr", f"{config.paddle_model} -> {'installed' if venv_python().exists() else 'not installed'}"
         if config.paddle_model else "off"),
        ("ports", f"{config.port} (gateway: /v1, /paddle) + {config.llama_port} (llama-server, localhost)"),
        ("api key", "set" if config.api_key else "none"),
    ]
    for key, value in rows:
        log(f"{key:>10}  {value}")
    if binary and config.device == "gpu":
        devices = list_devices(binary)
        log(f"{'gpus':>10}  {'; '.join(devices) if devices else 'none found by this build'}")
        if devices:
            log(f"{'using':>10}  {choose_gpu(config, devices)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="OCR server: HunyuanOCR (llama.cpp, OpenAI-compatible /v1) + PaddleOCR (/paddle)."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("setup", help="download and verify llama.cpp, the model and PaddleOCR")
    commands.add_parser("start", help="start the server (runs setup first if needed)")
    check_parser = commands.add_parser("check", help="check a running server; optionally OCR an image")
    check_parser.add_argument("image", nargs="?", help="PNG/JPEG page to run text spotting on")
    check_parser.add_argument("--paddle", action="store_true", help="check the PaddleOCR route instead of HunyuanOCR")
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
            return check_paddle(config, arguments.image) if arguments.paddle else check(config, arguments.image)
        return info(config)
    except ConfigError as error:
        log(f"Configuration error: {error}")
        return 2
    except (RuntimeError, urllib.error.URLError) as error:
        log(f"Error: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
