/// <reference lib="webworker" />

import { createSHA256 } from "hash-wasm";
import * as ort from "onnxruntime-web/webgpu";

import { DetectionError, detectTimestamp } from "@/lib/detector";
import { MAX_PIXELS, safeOutputName } from "@/lib/file-rules";
import { auditPixelChanges } from "@/lib/pixel-audit";
import type {
  ExecutionProvider,
  ProcessedImage,
  ProcessingReport,
  ProcessingStage,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/processing-types";

declare const self: DedicatedWorkerGlobalScope;

const MODEL_REVISION = "ea7cb42eca4643e71ba363771b3f6c0a8c1b1404";
const MODEL_SHA256 = "4b187e02a5e1eeab97a21ae39a3e780bc9943d64dd90dbaa9ffd73da12da52f0";
const MODEL_URL = `https://huggingface.co/Carve/LaMa-ONNX/resolve/${MODEL_REVISION}/lama_fp32.onnx`;
const MODEL_CACHE = "date-stamp-cleaner-model-v1";
const MODEL_SIZE = 1024;

let session: ort.InferenceSession | null = null;
let activeProvider: ExecutionProvider | null = null;
let modelPromise: Promise<{ session: ort.InferenceSession; provider: ExecutionProvider }> | null = null;

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

function progress(
  id: string,
  stage: ProcessingStage,
  value?: number,
  detail?: string,
  runtime?: { modelVerified?: boolean; provider?: ExecutionProvider },
): void {
  post({ type: "progress", id, stage, progress: value, detail, ...runtime });
}

function reflectIndex(value: number, length: number): number {
  if (length <= 1) return 0;
  const period = 2 * length - 2;
  const normalized = ((value % period) + period) % period;
  return normalized < length ? normalized : period - normalized;
}

function rgbaToRgb(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const rgb = new Uint8ClampedArray((rgba.length / 4) * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    if (rgba[source + 3] !== 255) {
      throw new Error("Transparent PNGs are not supported because their hidden RGB values cannot be preserved safely.");
    }
    rgb[target] = rgba[source];
    rgb[target + 1] = rgba[source + 1];
    rgb[target + 2] = rgba[source + 2];
  }
  return rgb;
}

function rgbToImageData(rgb: Uint8ClampedArray | Uint8Array, width: number, height: number): ImageData {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
    rgba[target] = rgb[source];
    rgba[target + 1] = rgb[source + 1];
    rgba[target + 2] = rgb[source + 2];
    rgba[target + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

async function decodeBlob(blob: Blob): Promise<{ rgb: Uint8ClampedArray; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      imageOrientation: "from-image",
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
  } catch {
    throw new Error("This image could not be decoded. Try exporting it as a standard JPG or PNG.");
  }

  const { width, height } = bitmap;
  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) {
    bitmap.close();
    throw new Error("This image exceeds the 40 megapixel decoded-pixel safety limit.");
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error("Your browser could not create a private image workspace.");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = context.getImageData(0, 0, width, height);
  return { rgb: rgbaToRgb(imageData.data), width, height };
}

async function sha256Bytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(source).buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Blob(blob: Blob): Promise<string> {
  return sha256Bytes(await blob.arrayBuffer());
}

async function loadVerifiedModel(id: string): Promise<Uint8Array> {
  progress(id, "model-download", 0, "Checking for a saved restoration model");
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE);
  } catch {
    // Private browsing and storage quotas can disable Cache API. Inference can
    // still continue safely after the downloaded bytes pass the same hash gate.
  }
  let response: Response | undefined;
  if (cache) {
    try {
      response = await cache.match(MODEL_URL);
    } catch {
      cache = null;
    }
  }
  const wasCached = Boolean(response);
  if (!response) {
    response = await fetch(MODEL_URL, { credentials: "omit", referrerPolicy: "no-referrer" });
  }
  if (!response.ok || !response.body) {
    throw new Error("The restoration model could not be downloaded. Check your connection and try again.");
  }

  const total = Number(response.headers.get("content-length")) || 208_044_816;
  const transferDetail = wasCached
    ? "Checking the saved local model"
    : "Downloading the on-device restoration model";
  progress(id, "model-download", 0, transferDetail);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const hasher = await createSHA256();
  let received = 0;
  let lastReportedPercent = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    hasher.update(value);
    received += value.byteLength;
    const transferProgress = Math.min(0.99, received / total);
    const wholePercent = Math.floor(transferProgress * 100);
    if (wholePercent > lastReportedPercent) {
      lastReportedPercent = wholePercent;
      progress(id, "model-download", transferProgress, transferDetail);
    }
  }

  const digest = hasher.digest("hex");
  if (digest !== MODEL_SHA256) {
    if (cache) await cache.delete(MODEL_URL).catch(() => false);
    throw new Error("The restoration model failed its safety check and was not used.");
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let wasStored = wasCached;
  if (!wasCached && cache) {
    try {
      await cache.put(
        MODEL_URL,
        new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.byteLength),
            "x-model-sha256": MODEL_SHA256,
          },
        }),
      );
      wasStored = true;
    } catch {
      wasStored = false;
    }
  }
  progress(
    id,
    "model-download",
    1,
    wasCached
      ? "Saved model integrity verified"
      : wasStored
        ? "Download complete; model integrity verified"
        : "Download verified; browser model cache unavailable",
    { modelVerified: true },
  );
  return bytes;
}

async function createModelSession(
  id: string,
  preferWebGpu: boolean,
): Promise<{ session: ort.InferenceSession; provider: ExecutionProvider }> {
  const gpuAvailable = Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
  const requestedProvider: ExecutionProvider = preferWebGpu && gpuAvailable ? "webgpu" : "wasm";
  if (session && activeProvider) return { session, provider: activeProvider };
  if (modelPromise) return modelPromise;

  modelPromise = (async () => {
    ort.env.logLevel = "warning";
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
      : 1;
    const model = await loadVerifiedModel(id);

    if (requestedProvider === "webgpu") {
      try {
        session = await ort.InferenceSession.create(model, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        });
        activeProvider = "webgpu";
        return { session, provider: "webgpu" };
      } catch {
        progress(id, "model-download", 1, "WebGPU unavailable; using compatibility mode", {
          modelVerified: true,
        });
      }
    }

    session = await ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    activeProvider = "wasm";
    return { session, provider: "wasm" };
  })();

  try {
    return await modelPromise;
  } finally {
    modelPromise = null;
  }
}

function extractCrop(
  rgb: Uint8ClampedArray,
  width: number,
  box: [number, number, number, number],
): { rgb: Uint8ClampedArray; width: number; height: number; x0: number; y0: number } {
  const [x0, y0, x1, y1] = box;
  const cropWidth = x1 - x0 + 1;
  const cropHeight = y1 - y0 + 1;
  const crop = new Uint8ClampedArray(cropWidth * cropHeight * 3);
  for (let y = 0; y < cropHeight; y += 1) {
    const sourceStart = ((y + y0) * width + x0) * 3;
    crop.set(rgb.subarray(sourceStart, sourceStart + cropWidth * 3), y * cropWidth * 3);
  }
  return { rgb: crop, width: cropWidth, height: cropHeight, x0, y0 };
}

function scaleRgb(
  rgb: Uint8ClampedArray,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): Uint8ClampedArray {
  if (width === targetWidth && height === targetHeight) return rgb;
  const source = new OffscreenCanvas(width, height);
  const sourceContext = source.getContext("2d");
  const target = new OffscreenCanvas(targetWidth, targetHeight);
  const targetContext = target.getContext("2d", { willReadFrequently: true });
  if (!sourceContext || !targetContext) throw new Error("The image resize workspace could not be created.");
  sourceContext.putImageData(rgbToImageData(rgb, width, height), 0, 0);
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = "high";
  targetContext.drawImage(source, 0, 0, targetWidth, targetHeight);
  return rgbaToRgb(targetContext.getImageData(0, 0, targetWidth, targetHeight).data);
}

function prepareModelInput(
  cropRgb: Uint8ClampedArray,
  cropMask: Uint8Array,
  cropWidth: number,
  cropHeight: number,
): {
  image: Float32Array;
  mask: Float32Array;
  scaledWidth: number;
  scaledHeight: number;
  offsetX: number;
  offsetY: number;
} {
  const scale = Math.min(1, MODEL_SIZE / cropWidth, MODEL_SIZE / cropHeight);
  const scaledWidth = Math.max(1, Math.round(cropWidth * scale));
  const scaledHeight = Math.max(1, Math.round(cropHeight * scale));
  const offsetX = Math.floor((MODEL_SIZE - scaledWidth) / 2);
  const offsetY = Math.floor((MODEL_SIZE - scaledHeight) / 2);
  const scaledRgb = scaleRgb(cropRgb, cropWidth, cropHeight, scaledWidth, scaledHeight);
  const scaledMask = new Uint8Array(scaledWidth * scaledHeight);

  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      if (cropMask[y * cropWidth + x] === 0) continue;
      const targetX = Math.min(scaledWidth - 1, Math.floor(x * scale));
      const targetY = Math.min(scaledHeight - 1, Math.floor(y * scale));
      scaledMask[targetY * scaledWidth + targetX] = 1;
    }
  }

  const plane = MODEL_SIZE * MODEL_SIZE;
  const image = new Float32Array(plane * 3);
  const mask = new Float32Array(plane);
  for (let y = 0; y < MODEL_SIZE; y += 1) {
    const localY = reflectIndex(y - offsetY, scaledHeight);
    for (let x = 0; x < MODEL_SIZE; x += 1) {
      const localX = reflectIndex(x - offsetX, scaledWidth);
      const source = (localY * scaledWidth + localX) * 3;
      const target = y * MODEL_SIZE + x;
      image[target] = scaledRgb[source] / 255;
      image[plane + target] = scaledRgb[source + 1] / 255;
      image[2 * plane + target] = scaledRgb[source + 2] / 255;
      if (
        x >= offsetX &&
        x < offsetX + scaledWidth &&
        y >= offsetY &&
        y < offsetY + scaledHeight
      ) {
        mask[target] = scaledMask[(y - offsetY) * scaledWidth + x - offsetX];
      }
    }
  }
  return { image, mask, scaledWidth, scaledHeight, offsetX, offsetY };
}

function extractGeneratedCrop(
  output: ort.Tensor,
  scaledWidth: number,
  scaledHeight: number,
  offsetX: number,
  offsetY: number,
  cropWidth: number,
  cropHeight: number,
): Uint8ClampedArray {
  const data = output.data as Float32Array;
  const plane = MODEL_SIZE * MODEL_SIZE;
  const scaled = new Uint8ClampedArray(scaledWidth * scaledHeight * 3);
  for (let y = 0; y < scaledHeight; y += 1) {
    for (let x = 0; x < scaledWidth; x += 1) {
      const source = (y + offsetY) * MODEL_SIZE + x + offsetX;
      const target = (y * scaledWidth + x) * 3;
      scaled[target] = Math.max(0, Math.min(255, Math.round(Number(data[source]))));
      scaled[target + 1] = Math.max(0, Math.min(255, Math.round(Number(data[plane + source]))));
      scaled[target + 2] = Math.max(0, Math.min(255, Math.round(Number(data[2 * plane + source]))));
    }
  }
  return scaleRgb(scaled, scaledWidth, scaledHeight, cropWidth, cropHeight);
}

async function reconstruct(
  id: string,
  original: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array,
  maskBox: [number, number, number, number],
  radius: number,
  preferWebGpu: boolean,
): Promise<{ final: Uint8ClampedArray; provider: ExecutionProvider }> {
  const padding = Math.max(80, Math.round(radius * 18));
  const expanded: [number, number, number, number] = [
    Math.max(0, maskBox[0] - padding),
    Math.max(0, maskBox[1] - padding),
    Math.min(width - 1, maskBox[2] + padding),
    Math.min(height - 1, maskBox[3] + padding),
  ];
  const crop = extractCrop(original, width, expanded);
  const cropMask = new Uint8Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      cropMask[y * crop.width + x] = mask[(y + crop.y0) * width + x + crop.x0];
    }
  }

  const prepared = prepareModelInput(crop.rgb, cropMask, crop.width, crop.height);
  const model = await createModelSession(id, preferWebGpu);
  progress(id, "reconstruct", 0.1, `Reconstructing locally with ${model.provider.toUpperCase()}`, {
    modelVerified: true,
    provider: model.provider,
  });
  const generated = await (async () => {
    const imageTensor = new ort.Tensor("float32", prepared.image, [1, 3, MODEL_SIZE, MODEL_SIZE]);
    const maskTensor = new ort.Tensor("float32", prepared.mask, [1, 1, MODEL_SIZE, MODEL_SIZE]);
    let output: ort.Tensor | undefined;
    try {
      const outputMap = await model.session.run({ image: imageTensor, mask: maskTensor });
      output = outputMap.output ?? Object.values(outputMap)[0];
      if (!output) throw new Error("The restoration model returned no image.");
      return extractGeneratedCrop(
        output,
        prepared.scaledWidth,
        prepared.scaledHeight,
        prepared.offsetX,
        prepared.offsetY,
        crop.width,
        crop.height,
      );
    } finally {
      imageTensor.dispose();
      maskTensor.dispose();
      output?.dispose();
    }
  })();

  const final = original.slice();
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const targetPixel = (y + crop.y0) * width + x + crop.x0;
      if (mask[targetPixel] === 0) continue;
      const source = (y * crop.width + x) * 3;
      const target = targetPixel * 3;
      final[target] = generated[source];
      final[target + 1] = generated[source + 1];
      final[target + 2] = generated[source + 2];
    }
  }
  progress(id, "reconstruct", 1, "Reconstruction complete");
  return { final, provider: model.provider };
}

async function encodePng(rgb: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The PNG export workspace could not be created.");
  context.putImageData(rgbToImageData(rgb, width, height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function processImage(id: string, file: File, preferWebGpu: boolean): Promise<ProcessedImage> {
  progress(id, "decode", 0.1, "Decoding privately on this device");
  const inputHashPromise = sha256Blob(file);
  const decoded = await decodeBlob(file);
  progress(id, "decode", 1, `${decoded.width.toLocaleString()} × ${decoded.height.toLocaleString()} pixels`);

  progress(id, "detect", 0.1, "Finding the supported orange date pattern");
  const detection = detectTimestamp(decoded.rgb, decoded.width, decoded.height);
  progress(id, "detect", 1, "Eight date glyphs found");

  const restored = await reconstruct(
    id,
    decoded.rgb,
    decoded.width,
    decoded.height,
    detection.mask,
    detection.report.maskBboxInclusive,
    detection.report.maskRadius,
    preferWebGpu,
  );

  progress(id, "encode", 0.2, "Writing a lossless PNG");
  const blob = await encodePng(restored.final, decoded.width, decoded.height);
  progress(id, "verify", 0.1, "Reopening and auditing every pixel");
  const reopened = await decodeBlob(blob);
  if (reopened.width !== decoded.width || reopened.height !== decoded.height) {
    throw new Error("The exported PNG dimensions changed during verification.");
  }

  const pixelAudit = auditPixelChanges(decoded.rgb, reopened.rgb, detection.mask);
  if (pixelAudit.changedPixelsOutsideMask !== 0) {
    throw new Error("Verification found a changed pixel outside the timestamp mask.");
  }

  try {
    detectTimestamp(reopened.rgb, reopened.width, reopened.height);
    throw new Error("The orange date sequence remained detectable after reconstruction.");
  } catch (error) {
    if (!(error instanceof DetectionError)) throw error;
  }

  const [inputSha256, outputSha256] = await Promise.all([inputHashPromise, sha256Blob(blob)]);
  const report: ProcessingReport = {
    ...detection.report,
    canonicalDimensions: [decoded.width, decoded.height],
    changedPixels: pixelAudit.changedPixels,
    changedPixelsOutsideMask: 0,
    timestampSequenceRedetected: false,
    outsideMaskRgbExact: true,
    editedAreaPercent: (detection.report.maskPixels * 100) / (decoded.width * decoded.height),
    inputSha256,
    outputSha256,
    modelSha256: MODEL_SHA256,
    modelRevision: MODEL_REVISION,
    executionProvider: restored.provider,
    outputFormat: "lossless PNG RGB, orientation normalized",
  };
  progress(id, "verify", 1, "Outside-mask pixels preserved exactly");
  return { blob, outputName: safeOutputName(file.name), report };
}

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "clear-model-cache") {
    try {
      await caches.delete(MODEL_CACHE);
    } catch {
      // Cache API may be disabled; the active in-memory session still clears.
    }
    session?.release();
    session = null;
    activeProvider = null;
    return;
  }

  try {
    const result = await processImage(request.id, request.file, request.preferWebGpu);
    post({ type: "result", id: request.id, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "This photo could not be processed.";
    const code = error instanceof DetectionError ? "not-found" : "processing-failed";
    post({ type: "error", id: request.id, message, code });
  }
});
