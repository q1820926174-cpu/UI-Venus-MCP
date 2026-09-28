/**
 * Screenshot pipeline (spec §31).
 *
 * Pure-JS image processing (pngjs / jpeg-js) so the MCP has no native
 * build requirements. Provides:
 *  - format detection & decode to RGBA
 *  - ROI cropping
 *  - downscaling (vision token saver)
 *  - PNG→JPEG recompression with quality
 *  - 8×8 average-hash (aHash) for same-screen / stagnation detection
 */
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import type { Screenshot } from "../core/types.js";

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel */
  data: Buffer;
}

export function detectFormat(buffer: Buffer): "png" | "jpeg" {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
  throw new Error("Unsupported image format (expected PNG or JPEG)");
}

export function decodeImage(buffer: Buffer): DecodedImage {
  const format = detectFormat(buffer);
  if (format === "png") {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  }
  const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
  return { width: raw.width, height: raw.height, data: Buffer.from(raw.data) };
}

export function encodePng(img: DecodedImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}

export function encodeJpeg(img: DecodedImage, quality = 80): Buffer {
  return jpeg.encode({ data: img.data, width: img.width, height: img.height }, quality).data;
}

/** Nearest-neighbor downscale; keeps aspect ratio, fits within maxSide. */
export function downscale(img: DecodedImage, maxSide: number): DecodedImage {
  const larger = Math.max(img.width, img.height);
  if (larger <= maxSide) return img;
  const ratio = maxSide / larger;
  const w = Math.max(1, Math.round(img.width * ratio));
  const h = Math.max(1, Math.round(img.height * ratio));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      const si = (sy * img.width + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = img.data[si] as number;
      out[di + 1] = img.data[si + 1] as number;
      out[di + 2] = img.data[si + 2] as number;
      out[di + 3] = img.data[si + 3] as number;
    }
  }
  return { width: w, height: h, data: out };
}

/** Crop a region (in image pixel coordinates, clamped). */
export function crop(img: DecodedImage, region: { x: number; y: number; width: number; height: number }): DecodedImage {
  const x = Math.max(0, Math.min(img.width - 1, Math.round(region.x)));
  const y = Math.max(0, Math.min(img.height - 1, Math.round(region.y)));
  const w = Math.max(1, Math.min(img.width - x, Math.round(region.width)));
  const h = Math.max(1, Math.min(img.height - y, Math.round(region.height)));
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * img.width + x) * 4;
    img.data.copy(out, row * w * 4, srcStart, srcStart + w * 4);
  }
  return { width: w, height: h, data: out };
}

/** 256-bit average hash (16×16), hex string. Hamming distance ≈ same screen. */
export function averageHash(img: DecodedImage): string {
  const small = downscaleGrayscale(img, 16, 16);
  const mean = small.reduce((a, b) => a + b, 0) / small.length;
  let hash = "";
  for (let byte = 0; byte < 64; byte++) {
    let v = 0;
    for (let bit = 0; bit < 4; bit++) {
      v = (v << 1) | (small[byte * 4 + bit]! > mean ? 1 : 0);
    }
    hash += v.toString(16).padStart(1, "0");
  }
  return hash;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return a.length * 4;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = (parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)) & 0xf;
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

function downscaleGrayscale(img: DecodedImage, w: number, h: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      const i = (sy * img.width + sx) * 4;
      const r = img.data[i]!;
      const g = img.data[i + 1]!;
      const b = img.data[i + 2]!;
      out.push(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
    }
  }
  return out;
}

export interface ProcessOptions {
  format?: "png" | "jpeg";
  jpegQuality?: number;
  maxDimension?: number;
}

/**
 * Post-process a raw screenshot buffer into a Screenshot record:
 * downscale for vision, optionally recompress, and compute aHash.
 */
export function processScreenshot(
  raw: Buffer,
  meta: {
    targetId: string;
    scale: number;
    origin: { x: number; y: number };
    orientation: "portrait" | "landscape";
  },
  opts: ProcessOptions = {},
): Screenshot {
  let img = decodeImage(raw);
  const fullSize = { width: img.width, height: img.height };
  const hash = averageHash(img);
  if (opts.maxDimension) img = downscale(img, opts.maxDimension);

  const format = opts.format ?? "png";
  let data: Buffer;
  if (format === "jpeg") {
    data = encodeJpeg(img, opts.jpegQuality ?? 80);
  } else {
    data = img.width === fullSize.width && img.height === fullSize.height ? raw : encodePng(img);
  }

  return {
    format,
    dataBase64: data.toString("base64"),
    width: img.width,
    height: img.height,
    scale: meta.scale > 0 ? (img.width / fullSize.width) * meta.scale : meta.scale,
    origin: meta.origin,
    orientation: meta.orientation,
    hash,
    capturedAt: Date.now(),
    targetId: meta.targetId,
  };
}
