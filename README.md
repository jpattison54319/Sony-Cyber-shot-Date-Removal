# Date Stamp Cleaner

Remove the orange `MM DD YYYY` date added by many Sony Cyber-shot cameras—entirely in your browser.

The public website has no photo-upload endpoint, account system, analytics, or photo database. A camera-specific detector finds the date, LaMa reconstructs only the saved binary mask, and every output is reopened and audited before a lossless PNG is offered for download.

## What users get

- One photo → one automatically downloaded, verified PNG.
- Multiple photos → one PNG-only ZIP, streamed directly to disk in supported desktop browsers.
- The visible picker accepts one or many photos; desktop users can also drag and drop, then add more before processing.
- Failed or uncertain detection → no edited output for that photo.
- Exact decoded-RGB preservation outside the detected timestamp mask.
- Sequential processing for bounded memory use across batches of up to 200 photos.

The hidden scene pixels were covered by the camera timestamp and cannot be historically recovered. The model reconstructs that small region; the exactness guarantee applies only outside the recorded mask.

## Privacy boundary

Photos are decoded and processed in a temporary Web Worker. They are not transmitted, persisted in browser storage, used for training, or logged. Selected file references remain available only in the open tab until the list is cleared or the page is closed.

After the first valid photo is chosen, the browser prepares the public LaMa ONNX model in the background and shows its progress. The photo is not involved in that request. Only the model from the commit-pinned Hugging Face URL may be cached locally; processing still works if browser storage is unavailable. The model is approximately 198 MiB and must match SHA-256:

```text
4b187e02a5e1eeab97a21ae39a3e780bc9943d64dd90dbaa9ffd73da12da52f0
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full data flow and threat boundary.

## Browser support

- Current desktop Chrome or Edge: recommended; WebGPU acceleration and streamed large-batch ZIP output.
- Safari and Firefox: ONNX WebAssembly compatibility mode; slower and limited to 25-photo in-memory ZIPs.
- Mobile browsers: native multi-select picker, a 25-photo ZIP limit, and a memory-safe single-threaded WASM profile.
- Inputs: JPG, JPEG, and opaque PNG; 30 MB and 40 megapixels per file; up to 200 files with streamed ZIP support.
- Outputs: lossless, orientation-normalized RGB PNG.

The workspace shows the mobile-safe, compatibility, or WebGPU mode before processing and the provider actually selected afterward. It also shows model download or cache-check progress and only reports `Verified` after the pinned SHA-256 matches.

## Development

Requires Node.js 24.

```bash
npm ci
npm run dev
```

The build bundles the required ONNX Runtime WebAssembly asset. The large LaMa model is intentionally not part of the Git repository or Vercel build.

Validation:

```bash
npm test
npm run lint
npm run typecheck
npm run audit:privacy
npm run build
```

`npm run build` finishes with `scripts/csp-audit.mjs`, which fails the build when the Content Security Policy in `vercel.json` would block the inline scripts the exported pages need in order to hydrate. That failure mode renders a complete-looking page whose buttons and photo picker do nothing, so it is checked on every build rather than left to be discovered in a browser.

The committed automated fixtures are generated arrays with no people or personal imagery. The browser port has not been validated against the original private family archive, and this repository does not claim that it has.

## Deploying on Vercel

Import `jpattison54319/Sony-Cyber-shot-Date-Removal` as a new Vercel project. The framework is detected as Next.js and exports a static site with no Functions or API routes.

No domain variable or runtime secret is required. Vercel automatically supplies `VERCEL_PROJECT_PRODUCTION_URL`; canonical and social metadata use that production domain, including a custom domain when one is attached.

## Project map

- `workers/processor.worker.ts` — private browser decoding, model loading, reconstruction, PNG export, and verification.
- `lib/detector.ts` — TypeScript port of the audited Sony orange-date detector.
- `components/cleaner-app.tsx` — accessible single/bulk workflow and local download handling.
- `reference/python-workflow/` — unchanged supplied Python workflow retained for audit provenance; never bundled into the site.
- `tests/` — synthetic detector, filename, pixel-boundary, ZIP, and 162-item regression checks.

## Provenance and licensing

The original workflow is MIT licensed. LaMa is Apache-2.0 licensed and its model weights are hosted separately. Runtime and UI dependency notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Sony and Cyber-shot are trademarks of their respective owner. This project is independent and uses the names only to describe compatible camera timestamps.
