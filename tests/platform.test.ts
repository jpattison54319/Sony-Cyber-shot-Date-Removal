import { describe, expect, it } from "vitest";

import { detectPlatform } from "@/components/platform-downloads";

describe("download platform recommendation", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", "windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", "macos"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64", "other"],
  ])("maps desktop user agents", (userAgent, platform, expected) => {
    expect(detectPlatform(userAgent, platform)).toBe(expected);
  });

  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)", "iPhone"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Mobile/15E148", "MacIntel"],
    ["Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) Mobile", "Linux armv8l"],
  ])("does not recommend a desktop installer on mobile", (userAgent, platform) => {
    expect(detectPlatform(userAgent, platform)).toBe("other");
  });
});
