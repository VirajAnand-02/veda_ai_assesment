import { MAX_PAGES } from "./constants";
import type { TextLine } from "./types";

// Runs in the browser. Turns an uploaded PDF or image into page images (what the
// teacher sees and what vision models read) plus, for PDFs with a text layer,
// the positioned text lines, which give exact highlight boxes without OCR.

export type PreparedPage = {
  image: Blob;
  width: number;
  height: number;
  /** Null for scans and photos, which need the vision model. */
  lines: TextLine[] | null;
};

const TARGET_WIDTH = 1600;
const MAX_IMAGE_EDGE = 2000;
const JPEG_QUALITY = 0.85;
/** Pages with less real text than this are treated as scans. */
const MIN_TEXT_LAYER_CHARS = 20;

export class PrepareError extends Error {}

export async function prepareDocument(file: File): Promise<PreparedPage[]> {
  return file.type === "application/pdf" ? preparePdf(file) : [await prepareImage(file)];
}

async function prepareImage(file: File): Promise<PreparedPage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file); // Applies EXIF orientation.
  } catch {
    throw new PrepareError(`“${file.name}” could not be opened as an image.`);
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = makeCanvas(bitmap.width * scale, bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { image: await toJpeg(canvas), width: canvas.width, height: canvas.height, lines: null };
}

async function preparePdf(file: File): Promise<PreparedPage[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let pdf;
  try {
    pdf = await task.promise;
  } catch {
    await task.destroy();
    throw new PrepareError(`“${file.name}” could not be opened. Is it a valid, unlocked PDF?`);
  }

  try {
    if (pdf.numPages > MAX_PAGES) {
      throw new PrepareError(`“${file.name}” has ${pdf.numPages} pages; the limit is ${MAX_PAGES}.`);
    }

    const pages: PreparedPage[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, TARGET_WIDTH / base.width) });

      const canvas = makeCanvas(viewport.width, viewport.height);
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;

      const content = await page.getTextContent();
      const lines = groupTextLines(content.items, viewport, pdfjs.Util.transform);

      pages.push({
        image: await toJpeg(canvas),
        width: canvas.width,
        height: canvas.height,
        lines: countChars(lines) >= MIN_TEXT_LAYER_CHARS ? lines : null,
      });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

type Viewport = { width: number; height: number; scale: number; transform: number[] };
type RawItem = { str?: string; transform?: number[]; width?: number };
type Transform = (a: number[], b: number[]) => number[];

type Fragment = { text: string; left: number; right: number; top: number; bottom: number; size: number };

/** Groups PDF text items into visual lines with page-fraction boxes. */
function groupTextLines(items: unknown[], viewport: Viewport, transform: Transform): TextLine[] {
  const fragments: Fragment[] = [];
  for (const item of items as RawItem[]) {
    if (!item.str?.trim() || !item.transform) continue;
    const [, , c, d, x, baseline] = transform(viewport.transform, item.transform);
    const size = Math.hypot(c, d);
    if (!size) continue;
    fragments.push({
      text: item.str,
      left: x,
      right: x + (item.width ?? 0) * viewport.scale,
      top: baseline - size,
      bottom: baseline + size * 0.25,
      size,
    });
  }

  fragments.sort((a, b) => a.bottom - b.bottom || a.left - b.left);

  const rows: Fragment[][] = [];
  for (const fragment of fragments) {
    const row = rows.at(-1);
    const last = row?.at(-1);
    if (row && last && Math.abs(fragment.bottom - last.bottom) < Math.min(fragment.size, last.size) * 0.5) {
      row.push(fragment);
    } else {
      rows.push([fragment]);
    }
  }

  const lines: TextLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.left - b.left);
    // Split a row where there's a wide gap, e.g. between two columns.
    let group: Fragment[] = [];
    const flush = () => {
      if (group.length) lines.push(toLine(group, viewport));
      group = [];
    };
    for (const fragment of row) {
      const previous = group.at(-1);
      if (previous && fragment.left - previous.right > previous.size * 3) flush();
      group.push(fragment);
    }
    flush();
  }
  return lines.filter((line) => line.text);
}

function toLine(group: Fragment[], viewport: Viewport): TextLine {
  let text = "";
  group.forEach((fragment, index) => {
    const previous = group[index - 1];
    const gap = previous ? fragment.left - previous.right : 0;
    text += previous && gap > previous.size * 0.15 && !text.endsWith(" ") ? ` ${fragment.text}` : fragment.text;
  });
  const left = Math.min(...group.map((f) => f.left));
  const right = Math.max(...group.map((f) => f.right));
  const top = Math.min(...group.map((f) => f.top));
  const bottom = Math.max(...group.map((f) => f.bottom));
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x = clamp(left / viewport.width);
  const y = clamp(top / viewport.height);
  return {
    text: text.replace(/\s+/g, " ").trim(),
    box: { x, y, w: clamp(right / viewport.width) - x, h: clamp(bottom / viewport.height) - y },
  };
}

const countChars = (lines: TextLine[]) =>
  lines.reduce((sum, line) => sum + line.text.replace(/\s/g, "").length, 0);

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new PrepareError("A page could not be rendered."))),
      "image/jpeg",
      JPEG_QUALITY,
    ),
  );
}
