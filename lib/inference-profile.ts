import type { InferenceProfile } from "./processing-types";

// The pinned Carve/LaMa-ONNX graph declares fixed image and mask inputs at
// 512 x 512. The original-resolution crop is restored after inference.
export const MODEL_INPUT_SIZE = 512;

export interface BrowserDeviceHints {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean };
}

export function inferenceProfileFor(hints: BrowserDeviceHints): InferenceProfile {
  if (hints.userAgentData?.mobile === true) return "mobile-safe";

  const userAgent = hints.userAgent ?? "";
  if (/Android|iPhone|iPad|iPod|IEMobile|Mobile/i.test(userAgent)) return "mobile-safe";

  // iPadOS can request desktop sites with a Macintosh user agent. A real Mac
  // does not expose multiple touch points, so this keeps desktop Macs standard.
  const platform = hints.platform ?? "";
  if (/^Mac/i.test(platform) && (hints.maxTouchPoints ?? 0) > 1) return "mobile-safe";

  return "standard";
}

export function getInferenceProfileSnapshot(): InferenceProfile {
  if (typeof navigator === "undefined") return "standard";
  const source = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return inferenceProfileFor({
    userAgent: source.userAgent,
    platform: source.platform,
    maxTouchPoints: source.maxTouchPoints,
    userAgentData: source.userAgentData,
  });
}

export function getServerInferenceProfileSnapshot(): InferenceProfile {
  return "standard";
}
