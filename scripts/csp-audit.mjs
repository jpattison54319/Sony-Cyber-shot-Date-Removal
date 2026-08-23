// Verifies that the Content-Security-Policy actually shipped by vercel.json
// permits every inline script and style the exported HTML depends on.
//
// This runs as `postbuild`, so a policy that would silently break hydration
// fails the deployment instead of publishing a page where nothing responds.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { auditDocument, auditStaticBoundary } from "./csp-policy.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(root, "out");

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

const vercel = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
const rule = vercel.headers?.find((entry) => entry.source === "/(.*)");
const policy = rule?.headers?.find((header) => header.key === "Content-Security-Policy")?.value;
if (!policy) {
  throw new Error("vercel.json does not ship a Content-Security-Policy for every path.");
}

let pages = [];
try {
  pages = await htmlFiles(outputDirectory);
} catch {
  pages = [];
}
if (pages.length === 0) {
  throw new Error("No exported HTML found in out/. Run `npm run build` before auditing the policy.");
}

const failures = [...auditStaticBoundary(policy)];
let inlineScripts = 0;

for (const page of pages) {
  const html = await readFile(page, "utf8");
  const result = auditDocument(policy, html, relative(root, page));
  inlineScripts += result.scriptCount;
  failures.push(...result.failures);
}

if (failures.length > 0) {
  console.error("Content-Security-Policy audit failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("\nUpdate the policy in vercel.json so the exported HTML can run.");
  process.exit(1);
}

console.log(
  `Content-Security-Policy audit passed: ${inlineScripts} inline script(s) across ${pages.length} exported page(s) can execute.`,
);
