# Browser architecture and invariants

## Static boundary

The production build is a static Next.js export. There are no route handlers, Server Actions, Vercel Functions, databases, object stores, analytics collectors, or authentication services.

The only runtime network request beyond static application assets is the public LaMa model download. Its URL is pinned to a specific Hugging Face revision, its SHA-256 is checked incrementally before inference, and a mismatch fails closed. The verified model response—not any photo—may be stored in the browser Cache API when storage is available.

## Photo data flow

1. The user grants access to local JPG, JPEG, or opaque PNG files.
2. A dedicated Web Worker decodes each file with EXIF orientation applied.
3. Decoded dimensions and resource limits are checked before processing continues.
4. The detector searches only the lower/right camera-date region and requires eight aligned orange glyph components with the supplied color, scale, position, baseline, and spacing rules.
5. Selected glyph cores are dilated by the supplied scale-derived radius.
6. A padded local crop and its mask are passed to the fixed 1024×1024 LaMa ONNX graph. WebGPU is preferred; WebAssembly is the compatibility provider.
7. Generated RGB values are copied only where the original-resolution binary mask is true.
8. The result is encoded as PNG, reopened, fully decoded, and compared with the canonical input.
9. Any changed pixel outside the mask or any redetected eight-glyph sequence rejects the output.
10. Successful single results download directly. Successful batch results are emitted sequentially into a PNG-only ZIP.

## Security and resource controls

- Allowed inputs: JPG, JPEG, and opaque PNG only.
- Limits: 30 MB, 40 megapixels, 200 selected files, and 500,000 orange-core candidates.
- User filenames are reduced to their final path component, normalized, stripped of control/path characters, and capped before being used in downloads.
- Files are processed sequentially; the model session is reused rather than reloaded for every photo.
- Large Chromium batches stream to a user-authorized file handle instead of accumulating all outputs in memory.
- Colliding source basenames receive deterministic numeric suffixes so no PNG is silently overwritten in a batch ZIP.
- Canceling terminates the worker, releases its model session, and stops the next file from starting.
- Content Security Policy restricts scripts, workers, image sources, and connections; cross-origin isolation enables bounded WASM threading where available.

## Honest validation boundary

The detector thresholds and mask rules are ported from the supplied Python source. Automated tests use synthetic, person-free RGB arrays only. The original private archive was explicitly excluded from development and has not been used to establish browser-port visual parity.

Different JPEG decoders, inference providers, and floating-point kernels can produce different reconstructed masked pixels. The outside-mask decoded-RGB invariant is re-established independently for every browser output and does not depend on model parity.
