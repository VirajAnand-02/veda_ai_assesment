# OCR server (PaddleOCR)

A local PaddleOCR server for the grading pipeline's `paddle-llm` reader
(`AI_OCR_ENGINE=paddle-llm`). It runs PP-OCR text detection and recognition with
[RapidOCR](https://github.com/RapidAI/RapidOCR) on ONNX Runtime, on the CPU, at
about 2–5 s per page.

```
app (lib/ocr/paddle.ts) ── POST /paddle/ocr ──► paddle_server.py (PaddleOCR, CPU)
```

The other reader, `nemotron-v1`, is hosted by NVIDIA and needs no local server.

## Quick start

```bash
cd OCR_server
python ocr_server.py start
```

The first run installs PaddleOCR into `OCR_server/.venv` (about 260 MB; around
20 s with [`uv`](https://docs.astral.sh/uv/), otherwise `pip`) and downloads the
model preset. When you see `>>> PaddleOCR is ready`, the app can use it.

The app finds it at `http://127.0.0.1:8090/paddle` by default; set
`PADDLE_OCR_URL` in the project's `.env.local` if it runs elsewhere.

Requirements: Python 3.9+ for the launcher (it uses only the standard library).

## Commands

| Command                               | What it does                                              |
| ------------------------------------- | --------------------------------------------------------- |
| `python ocr_server.py setup`          | Install PaddleOCR and download the model preset.          |
| `python ocr_server.py start`          | Run `setup` if needed, start the server, report when ready. |
| `python ocr_server.py check`          | Check that a running server is healthy.                   |
| `python ocr_server.py check page.png` | Read an image and print the text with boxes.              |
| `python ocr_server.py info`           | Show the resolved settings.                               |

Stop the server with **Ctrl+C**.

## API

- `POST /paddle/ocr` with `{"image": "<base64 or data URL>"}` returns
  `{"model", "lines": [{"text", "box": [xmin, ymin, xmax, ymax] (0–1000), "score"}], "width", "height", "durationMs"}`.
  Each entry is one detected text piece (in a table, usually one cell); the app
  joins pieces into lines.
- `GET /paddle/health` returns `{"ready", "model"}`.
- `GET /health` returns `{"status": "ok"}`.

## Settings

All settings are in [`.env.example`](.env.example):

| Variable              | Default                | Notes                                                        |
| --------------------- | ---------------------- | ------------------------------------------------------------ |
| `OCR_HOST` / `OCR_PORT` | `127.0.0.1` / `8090` | Use `0.0.0.0` to allow other machines, together with `OCR_API_KEY`. |
| `OCR_API_KEY`         | none                   | Bearer token; set the same value as `PADDLE_OCR_API_KEY` in the app. |
| `OCR_PADDLE_MODEL`    | `v6-small`             | `v6-tiny`, `v6-small`, `v6-medium`, `v5-mobile-en`.          |

Measured on this project's test pages (Ryzen 5 5600H): `v6-small` reads a
handwritten sheet in ~1.8 s and a typed A4 page in ~3.2 s; `v6-medium` is
~4× slower with slightly cleaner text.

The HunyuanOCR (llama.cpp) server that used to live here, with its downloads,
is archived in `/old_ocr/OCR_server` (not in git).
