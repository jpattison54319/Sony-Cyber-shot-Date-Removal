import { describe, expect, it } from "vitest";

import { inferenceProfileFor, MODEL_INPUT_SIZE } from "@/lib/inference-profile";

describe("inference profile selection", () => {
  it("uses the model's declared fixed input size", () => {
    expect(MODEL_INPUT_SIZE).toBe(1024);
  });

  it.each([
    ["iOS Chrome", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) CriOS/140.0 Mobile/15E148" }],
    ["Android Chrome", { userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36" }],
    ["iPad desktop user agent", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", platform: "MacIntel", maxTouchPoints: 5 }],
    ["client hint", { userAgent: "Desktop-looking agent", userAgentData: { mobile: true } }],
  ])("uses mobile-safe inference for %s", (_name, hints) => {
    expect(inferenceProfileFor(hints)).toBe("mobile-safe");
  });

  it.each([
    ["desktop Chrome", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36", platform: "MacIntel", maxTouchPoints: 0 }],
    ["touchscreen Windows laptop", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36", platform: "Win32", maxTouchPoints: 10 }],
  ])("keeps standard inference for %s", (_name, hints) => {
    expect(inferenceProfileFor(hints)).toBe("standard");
  });
});
