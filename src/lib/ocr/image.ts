import sharp from "sharp";

// Server-side image helpers (sharp).

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
