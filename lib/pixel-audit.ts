export interface PixelAudit {
  changedPixels: number;
  changedPixelsOutsideMask: number;
}

export function auditPixelChanges(
  original: Uint8Array | Uint8ClampedArray,
  saved: Uint8Array | Uint8ClampedArray,
  mask: Uint8Array,
): PixelAudit {
  if (original.length !== saved.length || original.length !== mask.length * 3) {
    throw new Error("Pixel audit buffers have incompatible dimensions.");
  }
  let changedPixels = 0;
  let changedPixelsOutsideMask = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * 3;
    const changed =
      saved[offset] !== original[offset] ||
      saved[offset + 1] !== original[offset + 1] ||
      saved[offset + 2] !== original[offset + 2];
    if (!changed) continue;
    changedPixels += 1;
    if (mask[pixel] === 0) changedPixelsOutsideMask += 1;
  }
  return { changedPixels, changedPixelsOutsideMask };
}
