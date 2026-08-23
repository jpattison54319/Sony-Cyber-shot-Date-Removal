import { describe, expect, it } from "vitest";

import { DetectionError, detectTimestamp } from "@/lib/detector";

function syntheticDateImage(width = 640, height = 480): Uint8ClampedArray {
  const rgb = new Uint8ClampedArray(width * height * 3).fill(80);
  const xPositions = [520, 526, 535, 541, 550, 556, 562, 568];
  for (const x0 of xPositions) {
    for (let y = 450; y < 456; y += 1) {
      for (let x = x0; x < x0 + 4; x += 1) {
        const offset = (y * width + x) * 3;
        rgb[offset] = 250;
        rgb[offset + 1] = 95;
        rgb[offset + 2] = 5;
      }
    }
  }
  return rgb;
}

describe("Sony Cyber-shot orange date detector", () => {
  it("finds an aligned eight-glyph date and expands its exact mask", () => {
    const detection = detectTimestamp(syntheticDateImage(), 640, 480);
    expect(detection.report.glyphComponents).toBe(8);
    expect(detection.report.glyphBboxesInclusive).toHaveLength(8);
    expect(detection.report.orangeCorePixels).toBe(192);
    expect(detection.report.maskPixels).toBeGreaterThan(detection.report.orangeCorePixels);
    expect(detection.report.maskRadius).toBe(3);
  });

  it("fails closed when no supported date is present", () => {
    const rgb = new Uint8ClampedArray(640 * 480 * 3).fill(80);
    expect(() => detectTimestamp(rgb, 640, 480)).toThrow(DetectionError);
  });

  it("does not treat orange scenery outside the camera-date region as a date", () => {
    const rgb = syntheticDateImage();
    for (let y = 20; y < 100; y += 1) {
      for (let x = 20; x < 180; x += 1) {
        const offset = (y * 640 + x) * 3;
        rgb[offset] = 250;
        rgb[offset + 1] = 95;
        rgb[offset + 2] = 5;
      }
    }
    expect(detectTimestamp(rgb, 640, 480).report.glyphComponents).toBe(8);
  });

  it("handles a generated 162-photo detector batch without shared state", { timeout: 20_000 }, () => {
    for (let index = 0; index < 162; index += 1) {
      const detection = detectTimestamp(syntheticDateImage(), 640, 480);
      expect(detection.report.glyphComponents).toBe(8);
    }
  });
});
