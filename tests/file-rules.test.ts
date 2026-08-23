import { describe, expect, it } from "vitest";

import {
  FALLBACK_BATCH_FILES,
  MAX_BATCH_FILES,
  MAX_FILE_BYTES,
  batchLimitForStreaming,
  reserveUniqueOutputName,
  safeOutputName,
  validateFile,
} from "@/lib/file-rules";
import { auditPixelChanges } from "@/lib/pixel-audit";

describe("local file safety rules", () => {
  it("accepts standard camera JPEGs and rejects oversized files", () => {
    expect(validateFile({ name: "DSC0012.JPG", type: "image/jpeg", size: 2_000_000 })).toBeNull();
    expect(validateFile({ name: "large.jpg", type: "image/jpeg", size: MAX_FILE_BYTES + 1 })).toContain("30 MB");
  });

  it("keeps non-streaming and mobile-style browsers within the bounded ZIP limit", () => {
    expect(batchLimitForStreaming(true)).toBe(MAX_BATCH_FILES);
    expect(batchLimitForStreaming(false)).toBe(FALLBACK_BATCH_FILES);
  });

  it("sanitizes paths and always creates a PNG name", () => {
    expect(safeOutputName("../../Family:Photo?.JPG")).toBe("Family-Photo--date-removed.png");
    expect(safeOutputName("photo.png")).toBe("photo-date-removed.png");
  });

  it("keeps colliding batch outputs distinct across case-sensitive and case-insensitive systems", () => {
    const used = new Set<string>();
    expect(reserveUniqueOutputName("Trip-date-removed.png", used)).toBe("Trip-date-removed.png");
    expect(reserveUniqueOutputName("trip-date-removed.png", used)).toBe("trip-date-removed-2.png");
    expect(reserveUniqueOutputName("Trip-date-removed.png", used)).toBe("Trip-date-removed-3.png");
  });
});

describe("outside-mask audit", () => {
  it("counts a masked edit without reporting outside changes", () => {
    const original = new Uint8Array([10, 10, 10, 20, 20, 20]);
    const saved = new Uint8Array([10, 10, 10, 30, 30, 30]);
    expect(auditPixelChanges(original, saved, new Uint8Array([0, 1]))).toEqual({
      changedPixels: 1,
      changedPixelsOutsideMask: 0,
    });
  });

  it("detects even one changed pixel outside the mask", () => {
    const original = new Uint8Array([10, 10, 10, 20, 20, 20]);
    const saved = new Uint8Array([11, 10, 10, 20, 20, 20]);
    expect(auditPixelChanges(original, saved, new Uint8Array([0, 1])).changedPixelsOutsideMask).toBe(1);
  });
});
