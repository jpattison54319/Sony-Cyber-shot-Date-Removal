import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(root, "public", "ort");

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  build({
    entryPoints: [join(root, "workers", "processor.worker.ts")],
    outfile: join(outputDirectory, "processor.worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["safari17", "chrome120", "firefox120"],
    minify: true,
    legalComments: "none",
    tsconfig: join(root, "tsconfig.json"),
  }),
  copyFile(
    join(root, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.asyncify.wasm"),
    join(outputDirectory, "ort-wasm-simd-threaded.asyncify.wasm"),
  ),
]);
