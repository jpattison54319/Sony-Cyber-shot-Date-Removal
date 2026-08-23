import { downloadZip } from "client-zip";
import { describe, expect, it } from "vitest";

describe("bulk output archive", () => {
  it("contains successful PNG files only", async () => {
    const response = downloadZip([
      { name: "one-date-removed.png", input: new Uint8Array([137, 80, 78, 71]), size: 4 },
      { name: "two-date-removed.png", input: new Uint8Array([137, 80, 78, 71]), size: 4 },
    ]);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const searchable = new TextDecoder("latin1").decode(bytes);
    expect(searchable).toContain("one-date-removed.png");
    expect(searchable).toContain("two-date-removed.png");
    expect(searchable).not.toContain("report.json");
  });
});
