import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain ESM audit helper shared with the build script.
import { auditDocument, auditStaticBoundary, integrityOf } from "../scripts/csp-policy.mjs";

const shippedPolicy: string = await (async () => {
  const vercel = JSON.parse(
    await readFile(fileURLToPath(new URL("../vercel.json", import.meta.url)), "utf8"),
  );
  const rule = vercel.headers.find((entry: { source: string }) => entry.source === "/(.*)");
  return rule.headers.find((header: { key: string }) => header.key === "Content-Security-Policy").value;
})();

// The exact shape a static Next.js export uses to hand its React payload to the
// client. Blocking it leaves a page that renders but never becomes interactive.
const hydrationScript = '<script>self.__next_f.push([1,"payload"])</script>';
const styleAttribute = '<span style="width: 40%"></span>';

describe("shipped deployment policy", () => {
  it("lets the exported hydration scripts run", () => {
    const { failures, scriptCount } = auditDocument(shippedPolicy, hydrationScript, "index.html");
    expect(scriptCount).toBe(1);
    expect(failures).toEqual([]);
  });

  it("allows inline styles used by the static export", () => {
    expect(auditDocument(shippedPolicy, styleAttribute, "index.html").failures).toEqual([]);
  });

  it("disables runtime connections, workers, and WebAssembly evaluation", () => {
    expect(auditStaticBoundary(shippedPolicy)).toEqual([]);
  });

  it("still forbids remote script origins", () => {
    expect(shippedPolicy).toContain("object-src 'none'");
    expect(shippedPolicy).toContain("base-uri 'self'");
    expect(shippedPolicy).toContain("frame-ancestors 'none'");
    expect(shippedPolicy).toContain("connect-src 'none'");
    expect(shippedPolicy).toContain("worker-src 'none'");
    expect(shippedPolicy).not.toContain("wasm-unsafe-eval");
  });
});

describe("policy audit", () => {
  const strict = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'none'; connect-src 'none'";

  it("reports a policy that would break hydration", () => {
    const { failures } = auditDocument(strict, hydrationScript, "index.html");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("React cannot hydrate");
  });

  it("accepts an inline script covered by a matching hash", () => {
    const body = 'self.__next_f.push([1,"payload"])';
    const hashed = `default-src 'self'; script-src 'self' '${integrityOf(body)}'; style-src 'self' 'unsafe-inline'`;
    expect(auditDocument(hashed, `<script>${body}</script>`, "index.html").failures).toEqual([]);
  });

  it("ignores 'unsafe-inline' when a hash is also present, as browsers do", () => {
    const hashed = `default-src 'self'; script-src 'self' 'unsafe-inline' '${integrityOf("other")}'`;
    expect(auditDocument(hashed, hydrationScript, "index.html").failures).toHaveLength(1);
  });

  it("does not flag inline JSON data blocks", () => {
    const json = '<script type="application/ld+json">{"a":1}</script>';
    const { failures, scriptCount } = auditDocument(strict, json, "index.html");
    expect(scriptCount).toBe(0);
    expect(failures).toEqual([]);
  });

  it("reports a policy that would drop inline style attributes", () => {
    const noStyleAttributes = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'";
    expect(auditDocument(noStyleAttributes, styleAttribute, "index.html").failures).toHaveLength(1);
  });

  it("reports a widened runtime surface", () => {
    const failures: string[] = auditStaticBoundary(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'",
    );
    expect(failures).toHaveLength(3);
    expect(failures.some((failure) => failure.includes("runtime network"))).toBe(true);
    expect(failures.some((failure) => failure.includes("desktop app"))).toBe(true);
    expect(failures.some((failure) => failure.includes("WebAssembly"))).toBe(true);
  });

  it("reports missing explicit connection and worker denial", () => {
    const failures: string[] = auditStaticBoundary("default-src 'self'; script-src 'self'");
    expect(failures).toHaveLength(2);
    expect(failures.some((failure) => failure.includes("connect-src"))).toBe(true);
    expect(failures.some((failure) => failure.includes("worker-src"))).toBe(true);
  });
});
