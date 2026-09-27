import sharp from "sharp";
import type { Box } from "@/lib/extraction/types";

// Server-side image helpers (sharp). Frames are page fractions, like boxes.

/** Splits a page into `count` horizontal strips that overlap by `overlap` of the page height. */
export async function cropStrips(
  image: Uint8Array,
  count: number,
  overlap = 0.1,
): Promise<{ image: Uint8Array; frame: Box }[]> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  if (!width || !height) throw new Error("Could not read the page image size.");

  const strips = [];
  for (let index = 0; index < count; index++) {
    const top = Math.max(0, Math.floor((index / count - overlap / 2) * height));
    const bottom = Math.min(height, Math.ceil(((index + 1) / count + overlap / 2) * height));
    const bytes = await sharp(image)
      .extract({ left: 0, top, width, height: bottom - top })
      .jpeg({ quality: 90 })
      .toBuffer();
    strips.push({ image: new Uint8Array(bytes), frame: { x: 0, y: top / height, w: 1, h: (bottom - top) / height } });
  }
  return strips;
}

export type Enhancement = {
  /** Contrast multiplier around mid-grey (1 = unchanged). */
  contrast: number;
  /** Added to every channel, 0–255 scale (0 = unchanged). */
  brightness: number;
};

export const DEFAULT_ENHANCEMENT: Enhancement = { contrast: 1.3, brightness: 15 };

/**
 * Raises contrast and brightness before OCR: paper and faint ruled lines move
 * towards white, ink towards black. out = contrast × (in − 128) + 128 + brightness.
 * Colour is kept (the vision LLM can use ink colour). Returns a JPEG.
 */
export async function enhancePage(image: Uint8Array, { contrast, brightness }: Enhancement = DEFAULT_ENHANCEMENT): Promise<Uint8Array> {
  const bytes = await sharp(image)
    .linear(contrast, 128 * (1 - contrast) + brightness)
    .jpeg({ quality: 92 })
    .toBuffer();
  return new Uint8Array(bytes);
}

/** Crops a page-fraction box (grown by `pad`) out of a page image as JPEG. */
export async function cropRegion(image: Uint8Array, box: Box, pad = 0.02): Promise<Uint8Array> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const left = Math.max(0, Math.floor((box.x - pad) * width));
  const top = Math.max(0, Math.floor((box.y - pad) * height));
  const right = Math.min(width, Math.ceil((box.x + box.w + pad) * width));
  const bottom = Math.min(height, Math.ceil((box.y + box.h + pad) * height));
  const bytes = await sharp(image)
    .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
    .jpeg({ quality: 90 })
    .toBuffer();
  return new Uint8Array(bytes);
}
