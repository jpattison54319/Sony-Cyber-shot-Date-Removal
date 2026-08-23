import { afterEach, describe, expect, it, vi } from "vitest";

import { createSafeId } from "@/lib/safe-id";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queue identifiers", () => {
  it("produces unique prefixed identifiers", () => {
    const ids = new Set(Array.from({ length: 500 }, () => createSafeId("photo")));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id.startsWith("photo-")).toBe(true);
  });

  it("still returns identifiers when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const ids = new Set(Array.from({ length: 200 }, () => createSafeId("photo")));
    expect(ids.size).toBe(200);
  });

  it("still returns identifiers when randomUUID throws in an insecure context", () => {
    vi.stubGlobal("crypto", {
      randomUUID() {
        throw new TypeError("randomUUID requires a secure context");
      },
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    });
    expect(createSafeId("photo").startsWith("photo-")).toBe(true);
  });

  it("still returns identifiers when no Web Crypto API exists at all", () => {
    vi.stubGlobal("crypto", undefined);
    const ids = new Set(Array.from({ length: 200 }, () => createSafeId("photo")));
    expect(ids.size).toBe(200);
  });
});
