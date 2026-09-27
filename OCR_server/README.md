# OCR server (HunyuanOCR + PaddleOCR)

A local OCR server for the app. It serves two OCR engines on one port:

| Route | Engine | Speed (this machine) |
| ----- | ------ | -------------------- |
| `/v1/chat/completions` | [HunyuanOCR-1.5](https://huggingface.co/tencent/HunyuanOCR), Tencent's 1B OCR vision model, via [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` (OpenAI-compatible) | 20–45 s/page on the GTX 1650 |
| `/paddle/ocr` | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv6 detection + recognition via [RapidOCR](https://github.com/RapidAI/RapidOCR) (ONNX Runtime, CPU) | 2–5 s/page |

`ocr_server.py` does everything: it downloads a prebuilt llama.cpp release and
the GGUF model (verified against their SHA-256 checksums), installs PaddleOCR
into `OCR_server/.venv`, and starts `llama-server` plus a small gateway
(`gateway.py`) that owns the public port. The launcher itself uses only the
Python standard library.

```
client ── :8090 gateway.py ─┬─ /v1/*, /health ──► llama-server :8091 (HunyuanOCR)
                            └─ /paddle/*       ──► PaddleOCR (in the gateway, CPU)
```

## Quick start

```bash
cd OCR_server
python ocr_server.py start
```

The first run downloads about **1.35 GB** (llama.cpp ~20–35 MB, model 578 MB,
vision encoder 733 MB) and installs PaddleOCR (~260 MB, about 20 s with `uv`).
Later starts take about 15 seconds. When you see `>>> OCR server is ready`,
open the app at <http://localhost:3000/ocr>.

The app finds the server through the project's `.env.local`:

```env
HUNYUAN_OCR_BASE_URL=http://127.0.0.1:8090/v1
HUNYUAN_OCR_MODEL=tencent/HunyuanOCR
HUNYUAN_OCR_MAX_TOKENS=4096
```

Requirements: Python 3.9+, Windows x64, Linux x64 or macOS (Apple Silicon),
about 1.5 GB of disk and 3 GB of free RAM.

PaddleOCR is found automatically at the same server (`/paddle`); set
`PADDLE_OCR_URL` in `.env.local` only if it lives elsewhere.

## PaddleOCR vs HunyuanOCR

Measured through the app on this project's test pages (boxes scored against a
typed PDF's own text layer):

| | PaddleOCR v6-small (CPU) | HunyuanOCR (GTX 1650) |
| --- | --- | --- |
| Typed A4 page | **3–5 s**, IoU 0.83, 20/20 lines | 23–45 s, IoU 0.80, 20/20 lines |
| Handwritten sheet | **2 s**, most lines right; one line garbled ("cle t se ut r as"), stray marks on the drawing | 25–40 s, every line right |

So PaddleOCR is ~10× faster with equally precise boxes, but its handwriting
recognition is weaker. `OCR_PADDLE_MODEL=v6-medium` reads a bit more cleanly at
~4× the time.

`POST /paddle/ocr` takes `{"image": "<base64 or data URL>"}` and returns
`{"model", "lines": [{"text", "box": [xmin, ymin, xmax, ymax] (0–1000), "score"}], "width", "height", "durationMs"}`.

## CPU or GPU

Set `OCR_DEVICE` in `OCR_server/.env` (or as an environment variable):

| `OCR_DEVICE`  | What runs                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------ |
| `cpu` (default) | llama.cpp's CPU build; nothing touches the GPU.                                          |
| `gpu`         | Vulkan build by default (any vendor, small download), or `OCR_GPU_BACKEND=cuda` for NVIDIA. macOS uses Metal. |

```bash
OCR_DEVICE=gpu python ocr_server.py start        # bash
$env:OCR_DEVICE="gpu"; python ocr_server.py start # PowerShell
```

In GPU mode the server lists the GPUs it finds and picks the dedicated one
(NVIDIA, AMD RX, Intel Arc) over integrated graphics. Choose another with
`OCR_GPU_DEVICE` (for example `Vulkan0`); `python ocr_server.py info` shows the
options.

### Measured on this machine (Ryzen 5 5600H, GTX 1650 4 GB)

| Page (as sent)                                         | CPU   | GPU (Vulkan) |
| ------------------------------------------------------ | ----- | ------------ |
| Typed A4 answer page, 1131×1600, 20 lines              | 119 s | 35–45 s      |
| Handwritten answer sheet, 1122×1402, 64 items          | 194 s | 20–80 s      |
| Short typed page, ~900 image tokens                    | —     | 9–11 s       |

GPU timings on this laptop vary a lot between runs, and the first request after
a GPU start is slower while Vulkan compiles its shaders. Output speed was about
14 tokens/s on CPU and 65–80 tokens/s on the GPU.

On the typed page, HunyuanOCR's boxes overlapped the exact text positions with a
mean IoU of 0.80 (34/34 lines ≥ 0.5). The DeepSeek vision LLM scored 0.04–0.15
on the same pages.

**What makes it faster:**

- **Smaller images.** Image tokens grow with area: a 1600×2263 page is about
  3,700 tokens, while 1131×1600 is about 1,900 with the same accuracy. The app's
  `/ocr` page scales pages to a 1600 px long edge before sending them.
- **A small context on small GPUs.** With `OCR_CTX_SIZE=16384` the 4 GB card was
  nearly full and image processing ran at 28 tokens/s; at `8192` (the default)
  it ran at 100–130 tokens/s.

## Commands

| Command                              | What it does                                                         |
| ------------------------------------ | -------------------------------------------------------------------- |
| `python ocr_server.py setup`         | Download and verify llama.cpp and the model for the current settings. |
| `python ocr_server.py start`         | Run `setup` if needed, start the server, and report when it's ready.  |
| `python ocr_server.py check`         | Check that a running server is healthy and lists the model.           |
| `python ocr_server.py check page.png`| Run a real text-spotting request on an image and print the lines.     |
| `python ocr_server.py check --paddle page.png` | Same, through PaddleOCR (`/paddle/ocr`).                    |
| `python ocr_server.py info`          | Show the resolved settings, what's downloaded, and the GPUs found.    |

Stop the server with **Ctrl+C**.

## Settings

All settings are in [`.env.example`](.env.example). The main ones:

| Variable              | Default                                      | Notes                                                                    |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| `OCR_DEVICE`          | `cpu`                                        | `cpu` or `gpu`.                                                          |
| `OCR_GPU_BACKEND`     | `vulkan`                                     | `vulkan` or `cuda` (Windows/Linux).                                      |
| `OCR_GPU_DEVICE`      | automatic                                    | e.g. `Vulkan1`, `CUDA0`.                                                 |
| `OCR_HOST` / `OCR_PORT` | `127.0.0.1` / `8090`                       | Gateway port; llama-server uses `OCR_PORT + 1` (localhost only). Use `0.0.0.0` to allow other machines, together with `OCR_API_KEY`. |
| `OCR_PADDLE`          | `on`                                         | `off` skips the PaddleOCR install and route.                             |
| `OCR_PADDLE_MODEL`    | `v6-small`                                   | `v6-tiny`, `v6-small`, `v6-medium`, `v5-mobile-en`.                      |
| `OCR_API_KEY`         | none                                         | Bearer token; set the same value as `HUNYUAN_OCR_API_KEY` in the app.    |
| `OCR_MODEL_ALIAS`     | `tencent/HunyuanOCR`                         | Must match the app's `HUNYUAN_OCR_MODEL`.                                |
| `OCR_MODEL_QUANT`     | `Q8_0`                                       | Smaller: `Q5_K_M`, `Q4_K_M`. Larger: `F16`.                              |
| `OCR_MMPROJ_QUANT`    | `q8_0`                                       | Vision encoder: `q8_0`, `f16`, `bf16`.                                   |
| `OCR_CTX_SIZE`        | `8192`                                       | Image tokens + output per request.                                       |
| `OCR_MAX_TOKENS`      | `4096`                                       | Output limit per request.                                                |
| `OCR_LLAMA_BUILD`     | `b11201`                                     | Pinned llama.cpp release.                                                |

## How it fits together

```
Next.js app  ── POST /api/ocr ──►  src/lib/ocr/hunyuan.ts
                                        │  OpenAI-compatible request:
                                        │  image + Tencent's "spotting_json" prompt
                                        ▼
                         OCR_server: llama-server  (this folder)
                                        │  HunyuanOCR-1.5 GGUF (+ vision encoder)
                                        ▼
               [{"box": [xmin, ymin, xmax, ymax] (0–1000), "text": "…"}, …]
```

The app uses two HunyuanOCR tasks: **spotting** (text lines with boxes) and
**layout** (regions such as `paragraph`, `formula` and `figure`). Spotting can't
see drawings, so the app's *hybrid* reader (`AI_OCR_ENGINE=hybrid`) takes the
`figure` regions from layout, grows each one to include the labels written around
it, and asks the vision LLM to describe the cropped drawing. The result is one
`[diagram: …]` line per drawing that grading can use.

The server runs one request at a time, with Tencent's recommended settings
(temperature 0, repetition penalty 1.08), and no prompt cache or web UI to save
memory.

## Notes and limits

- **Model files.** Tencent publishes only PyTorch weights. The GGUF conversion
  used here is the community repo
  [`prithivMLmods/HunyuanOCR-1.5-GGUF-Updated`](https://huggingface.co/prithivMLmods/HunyuanOCR-1.5-GGUF-Updated)
  (version 1.5, checksums verified on download). To use your own conversion,
  follow [Tencent's llama.cpp guide](https://github.com/Tencent-Hunyuan/HunyuanOCR/blob/main/docs/llama_cpp.md)
  and change `OCR_MODEL_REPO`, or place files in `models/` with the same names.
- **Words vs lines.** On widely spaced handwriting, HunyuanOCR often returns
  individual words rather than whole lines.
- **DFlash** (Tencent's speculative decoding, about 2× faster output) needs a
  draft model converted from the PyTorch weights and isn't set up here.
- **License.** HunyuanOCR is released under the
  [Tencent Hunyuan Community License](https://github.com/Tencent-Hunyuan/HunyuanOCR/blob/main/LICENSE).
- Downloads go to `bin/` and `models/`, which are git-ignored. Delete them to
  force a fresh download.
