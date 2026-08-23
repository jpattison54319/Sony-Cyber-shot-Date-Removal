import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientFiles = [
  join(root, "components", "download-app.tsx"),
  join(root, "components", "platform-downloads.tsx"),
];

for (const file of clientFiles) {
  const source = await readFile(file, "utf8");
  for (const forbidden of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket(", "FormData("]) {
    if (source.includes(forbidden)) throw new Error(`${forbidden} is not allowed in photo-facing client code: ${file}`);
  }
}

const appEntries = await readdir(join(root, "app"), { recursive: true });
if (appEntries.some((entry) => entry.endsWith("route.ts") || entry.endsWith("route.js"))) {
  throw new Error("Static privacy boundary violated: an application route handler exists.");
}

const vercel = await readFile(join(root, "vercel.json"), "utf8");
if (!vercel.includes("connect-src 'none'") || !vercel.includes("worker-src 'none'")) {
  throw new Error("The installer site's deployment CSP must disable runtime connections and workers.");
}

try {
  await access(join(root, "app", "api"));
  throw new Error("Static privacy boundary violated: app/api exists.");
} catch (error) {
  if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
}

console.log("Privacy audit passed: the installer site has no runtime network path or server route.");
