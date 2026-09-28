import { describe, expect, it } from "vitest";
import {
  detectFormat,
  decodeImage,
  encodePng,
  encodeJpeg,
  downscale,
  crop,
  averageHash,
  hammingDistance,
  processScreenshot,
} from "../../src/screenshot/pipeline.js";
import { PNG } from "pngjs";

function makePng(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = fill(x, y);
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("screenshot pipeline (spec §31)", () => {
  it("detects formats", () => {
    const png = makePng(4, 4, () => [255, 0, 0]);
    expect(detectFormat(png)).toBe("png");
    const jpeg = encodeJpeg({ width: 4, height: 4, data: Buffer.alloc(4 * 4 * 4, 128) }, 80);
    expect(detectFormat(jpeg)).toBe("jpeg");
  });

  it("decodes + re-encodes PNG losslessly", () => {
    const png = makePng(8, 8, (x, y) => [(x * 31) % 256, (y * 17) % 256, 7]);
    const img = decodeImage(png);
    expect(img.width).toBe(8);
    expect(encodePng(img)).toBeTruthy();
  });

  it("downscales preserving aspect ratio", () => {
    const img = { width: 2000, height: 1000, data: Buffer.alloc(2000 * 1000 * 4, 100) };
    const small = downscale(img, 1000);
    expect(small.width).toBe(1000);
    expect(small.height).toBe(500);
  });

  it("crop extracts a subregion", () => {
    const img = { width: 10, height: 10, data: Buffer.alloc(10 * 10 * 4, 0) };
    // paint a red square at (5,5)-(7,7)
    for (let y = 5; y <= 7; y++)
      for (let x = 5; x <= 7; x++) {
        const i = (y * 10 + x) * 4;
        img.data[i] = 255;
        img.data[i + 3] = 255;
      }
    const c = crop(img, { x: 5, y: 5, width: 3, height: 3 });
    expect(c.width).toBe(3);
    expect(c.height).toBe(3);
    expect(c.data[0]).toBe(255); // red preserved
    expect(c.data[1]).toBe(0);
  });

  it("averageHash is stable for identical images and far for different ones", () => {
    const a = decodeImage(makePng(64, 64, () => [200, 200, 200]));
    const a2 = decodeImage(makePng(64, 64, () => [201, 200, 199]));
    const b = decodeImage(makePng(64, 64, (x, y) => (x < 32 !== y < 32 ? [10, 10, 10] : [240, 240, 240])));
    const ha = averageHash(a);
    expect(hammingDistance(ha, averageHash(a2))).toBeLessThanOrEqual(2);
    expect(hammingDistance(ha, averageHash(b))).toBeGreaterThan(8);
  });

  it("processScreenshot attaches metadata and downscales for vision", () => {
    const raw = makePng(3000, 1500, () => [100, 150, 200]);
    const shot = processScreenshot(
      raw,
      { targetId: "t1", scale: 2, origin: { x: 10, y: 20 }, orientation: "landscape" },
      { maxDimension: 1500, format: "jpeg", jpegQuality: 70 },
    );
    expect(shot.width).toBe(1500);
    expect(shot.height).toBe(750);
    expect(shot.format).toBe("jpeg");
    expect(shot.scale).toBeCloseTo(1); // halved image halves the effective scale
    expect(shot.origin).toEqual({ x: 10, y: 20 });
    expect(shot.hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
