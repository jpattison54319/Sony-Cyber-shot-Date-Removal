import { describe, expect, it } from "vitest";

import { DEFAULT_SITE_ORIGIN, resolveMetadataBase } from "@/lib/site-url";

describe("metadata base URL", () => {
  it.each([undefined, "", "   "])("uses the production fallback for %j", (value) => {
    expect(resolveMetadataBase(value).href).toBe(`${DEFAULT_SITE_ORIGIN}/`);
  });

  it("turns Vercel's automatic production domain into an HTTPS origin", () => {
    expect(resolveMetadataBase("  photos.example.com  ").href).toBe("https://photos.example.com/");
  });

  it.each(["not a domain", "https://example.com", "user:secret@example.com", "example.com/path"])(
    "fails safely for invalid or unsafe configuration %s",
    (value) => {
      expect(resolveMetadataBase(value).href).toBe(`${DEFAULT_SITE_ORIGIN}/`);
    },
  );
});
