export const DETECTOR_PROFILE = "sony-cybershot-orange-mm-dd-yyyy-v1";

const MAX_ORANGE_CORE_PIXELS = 500_000;

export interface BoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Component extends BoundingBox {
  area: number;
  pixels: number[];
}

export interface DetectionReport {
  detectorProfile: string;
  detectorScore: number;
  glyphComponents: 8;
  glyphBboxesInclusive: Array<[number, number, number, number]>;
  medianGlyphHeight: number;
  maskRadius: number;
  orangeCorePixels: number;
  maskPixels: number;
  coreBboxInclusive: [number, number, number, number];
  maskBboxInclusive: [number, number, number, number];
}

export interface TimestampDetection {
  core: Uint8Array;
  mask: Uint8Array;
  report: DetectionReport;
}

export class DetectionError extends Error {
  constructor(message = "No supported orange date stamp was found.") {
    super(message);
    this.name = "DetectionError";
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function standardDeviation(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function heightOf(component: Component): number {
  return component.y1 - component.y0 + 1;
}

function centerY(component: Component): number {
  return 0.5 * (component.y0 + component.y1);
}

function sequenceScore(sequence: Component[], width: number, height: number): number | null {
  const ordered = [...sequence].sort((a, b) => a.x0 - b.x0);
  if (ordered.length !== 8) return null;
  if (ordered.some((component, index) => index > 0 && ordered[index - 1].x1 >= component.x0)) {
    return null;
  }

  const heights = ordered.map(heightOf);
  const centers = ordered.map(centerY);
  const medianHeight = median(heights);
  if (medianHeight <= 0) return null;
  if (Math.min(...heights) < 0.58 * medianHeight || Math.max(...heights) > 1.42 * medianHeight) {
    return null;
  }
  if (Math.max(...centers) - Math.min(...centers) > 0.34 * medianHeight) return null;

  const span = ordered[7].x1 - ordered[0].x0 + 1;
  const spanRatio = span / medianHeight;
  if (spanRatio < 5.2 || spanRatio > 16.5) return null;

  const gaps = ordered.slice(1).map((component, index) => component.x0 - ordered[index].x1 - 1);
  if (Math.max(...gaps) > 2.5 * medianHeight) return null;
  if (gaps[1] < 0.16 * medianHeight || gaps[3] < 0.16 * medianHeight) return null;
  const ordinaryGapMedian = median([gaps[0], gaps[2], gaps[4], gaps[5], gaps[6]]);
  if (gaps[1] < ordinaryGapMedian || gaps[3] < ordinaryGapMedian) return null;

  const bottom = Math.max(...ordered.map((component) => component.y1)) / height;
  const right = ordered[7].x1 / width;
  if (bottom < 0.78 || right < 0.7) return null;

  const heightCv = standardDeviation(heights) / medianHeight;
  const baselineCv = standardDeviation(centers) / medianHeight;
  const spacingBonus = (gaps[1] + gaps[3]) / (2 * medianHeight);
  const area = ordered.reduce((sum, component) => sum + component.area, 0);
  return (
    7 * right +
    5 * bottom +
    0.25 * Math.log1p(area) +
    0.8 * spacingBonus -
    4 * heightCv -
    5 * baselineCv -
    0.08 * Math.abs(spanRatio - 10)
  );
}

function inclusiveBoundingBox(indices: Iterable<number>, width: number): [number, number, number, number] {
  let x0 = width;
  let y0 = Number.MAX_SAFE_INTEGER;
  let x1 = -1;
  let y1 = -1;
  for (const index of indices) {
    const x = index % width;
    const y = Math.floor(index / width);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (x1 < 0) throw new DetectionError("The detected date mask was empty.");
  return [x0, y0, x1, y1];
}

function isOrangeCore(rgb: Uint8ClampedArray | Uint8Array, pixelIndex: number): boolean {
  const offset = pixelIndex * 3;
  const red = rgb[offset];
  const green = rgb[offset + 1];
  const blue = rgb[offset + 2];
  return (
    red >= 210 &&
    green >= 55 &&
    green <= 140 &&
    blue <= 40 &&
    red - green >= 90 &&
    green - blue >= 35
  );
}

function collectComponents(
  rgb: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Component[] {
  const xStart = Math.floor(0.38 * width);
  const yStart = Math.floor(0.68 * height);
  const roiWidth = width - xStart;
  const roiHeight = height - yStart;
  const core = new Uint8Array(roiWidth * roiHeight);
  let coreCount = 0;

  for (let y = 0; y < roiHeight; y += 1) {
    for (let x = 0; x < roiWidth; x += 1) {
      const sourceIndex = (y + yStart) * width + x + xStart;
      if (isOrangeCore(rgb, sourceIndex)) {
        core[y * roiWidth + x] = 1;
        coreCount += 1;
      }
    }
  }

  if (coreCount > MAX_ORANGE_CORE_PIXELS) {
    throw new DetectionError("This image contains too much matching orange area to process safely.");
  }

  const minimumArea = Math.max(20, Math.round(width * height * 8e-7));
  const components: Component[] = [];
  const stack: number[] = [];

  for (let start = 0; start < core.length; start += 1) {
    if (core[start] === 0) continue;
    core[start] = 0;
    stack.push(start);
    const pixels: number[] = [];
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;

    while (stack.length > 0) {
      const current = stack.pop()!;
      const localX = current % roiWidth;
      const localY = Math.floor(current / roiWidth);
      const sourceX = localX + xStart;
      const sourceY = localY + yStart;
      pixels.push(sourceY * width + sourceX);
      x0 = Math.min(x0, sourceX);
      y0 = Math.min(y0, sourceY);
      x1 = Math.max(x1, sourceX);
      y1 = Math.max(y1, sourceY);

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = localX + dx;
          const ny = localY + dy;
          if (nx < 0 || nx >= roiWidth || ny < 0 || ny >= roiHeight) continue;
          const neighbor = ny * roiWidth + nx;
          if (core[neighbor] === 1) {
            core[neighbor] = 0;
            stack.push(neighbor);
          }
        }
      }
    }

    const component: Component = { area: pixels.length, x0, y0, x1, y1, pixels };
    if (component.area < minimumArea) continue;
    const componentHeight = heightOf(component);
    const componentWidth = component.x1 - component.x0 + 1;
    if (componentHeight < 0.006 * height || componentHeight > 0.065 * height) continue;
    if (componentWidth > 0.065 * width) continue;
    components.push(component);
  }

  return components;
}

export function detectTimestamp(
  rgb: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): TimestampDetection {
  if (rgb.length !== width * height * 3) {
    throw new DetectionError("The decoded RGB buffer has unexpected dimensions.");
  }

  const components = collectComponents(rgb, width, height);
  let best: { score: number; sequence: Component[] } | null = null;

  for (const anchor of components) {
    const anchorHeight = heightOf(anchor);
    const aligned = components
      .filter((component) => {
        const componentHeight = heightOf(component);
        return (
          Math.abs(centerY(component) - centerY(anchor)) <= 0.34 * Math.max(componentHeight, anchorHeight) &&
          componentHeight / anchorHeight >= 0.55 &&
          componentHeight / anchorHeight <= 1.8
        );
      })
      .sort((a, b) => a.x0 - b.x0);

    const windowCount = Math.max(0, aligned.length - 7);
    for (let start = 0; start < windowCount; start += 1) {
      const sequence = aligned.slice(start, start + 8);
      const score = sequenceScore(sequence, width, height);
      if (score !== null && (best === null || score > best.score)) best = { score, sequence };
    }
  }

  if (best === null) throw new DetectionError();

  const ordered = [...best.sequence].sort((a, b) => a.x0 - b.x0);
  const selectedPixels = ordered.flatMap((component) => component.pixels);
  const core = new Uint8Array(width * height);
  for (const index of selectedPixels) core[index] = 1;

  const medianGlyphHeight = median(ordered.map(heightOf));
  const maskRadius = Math.min(14, Math.max(3, Math.round(0.095 * medianGlyphHeight)));
  const offsets: Array<[number, number]> = [];
  for (let dy = -maskRadius; dy <= maskRadius; dy += 1) {
    for (let dx = -maskRadius; dx <= maskRadius; dx += 1) {
      if (dx * dx + dy * dy <= maskRadius * maskRadius) offsets.push([dx, dy]);
    }
  }

  const mask = new Uint8Array(width * height);
  for (const index of selectedPixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    for (const [dx, dy] of offsets) {
      const targetX = x + dx;
      const targetY = y + dy;
      if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) {
        mask[targetY * width + targetX] = 1;
      }
    }
  }

  let maskPixels = 0;
  const maskIndices: number[] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 1) {
      maskPixels += 1;
      maskIndices.push(index);
    }
  }

  return {
    core,
    mask,
    report: {
      detectorProfile: DETECTOR_PROFILE,
      detectorScore: best.score,
      glyphComponents: 8,
      glyphBboxesInclusive: ordered.map((component) => [
        component.x0,
        component.y0,
        component.x1,
        component.y1,
      ]),
      medianGlyphHeight,
      maskRadius,
      orangeCorePixels: selectedPixels.length,
      maskPixels,
      coreBboxInclusive: inclusiveBoundingBox(selectedPixels, width),
      maskBboxInclusive: inclusiveBoundingBox(maskIndices, width),
    },
  };
}
