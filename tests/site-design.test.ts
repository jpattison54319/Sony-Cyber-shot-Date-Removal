import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const readProjectFile = (relativePath: string) =>
  readFile(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");

describe("site design guardrails", () => {
  it("avoids decorative landing-page effects", async () => {
    const styles = await readProjectFile("app/globals.css");

    expect(styles).not.toMatch(/gradient|backdrop-filter|box-shadow/i);
  });

  it("avoids badge-heavy and editorial landing-page patterns", async () => {
    const interfaceSource = await readProjectFile("components/download-app.tsx");

    expect(interfaceSource).not.toMatch(/eyebrow|kicker|proof|badge|honesty-card/i);
  });

  it("contains no em dashes in user-facing site source", async () => {
    const sources = await Promise.all([
      readProjectFile("app/layout.tsx"),
      readProjectFile("components/download-app.tsx"),
      readProjectFile("components/platform-downloads.tsx"),
    ]);

    expect(sources.join("\n")).not.toContain("—");
  });
});
