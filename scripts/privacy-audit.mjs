import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientFiles = [
  join(root, "components", "cleaner-app.tsx"),
  join(root, "lib", "worker-client.ts"),
];

for (const file of clientFiles) {
  const source = await readFile(file, "utf8");
  for (const forbidden of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket(", "FormData("]) {
    if (source.includes(forbidden)) throw new Error(`${forbidden} is not allowed in photo-facing client code: ${file}`);
  }
}

const worker = await readFile(join(root, "workers", "processor.worker.ts"), "utf8");
const fetchCalls = worker.match(/\bfetch\(/g)?.length ?? 0;
if (fetchCalls !== 1 || !worker.includes("huggingface.co/Carve/LaMa-ONNX")) {
  throw new Error("The worker may fetch only the pinned public LaMa model.");
}

const appEntries = await readdir(join(root, "app"), { recursive: true });
if (appEntries.some((entry) => entry.endsWith("route.ts") || entry.endsWith("route.js"))) {
  throw new Error("Static privacy boundary violated: an application route handler exists.");
}

const vercel = await readFile(join(root, "vercel.json"), "utf8");
if (!vercel.includes("connect-src 'self' https://huggingface.co https://*.hf.co")) {
  throw new Error("The deployment CSP does not restrict runtime connections as expected.");
}

try {
  await access(join(root, "app", "api"));
  throw new Error("Static privacy boundary violated: app/api exists.");
} catch (error) {
  if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
}

console.log("Privacy audit passed: no photo network path or server route found.");
