# Desktop architecture and invariants

## Product boundary

The Vercel deployment is a static installer page. It does not accept photos or
run the model. Its Content Security Policy disables runtime connections and
workers, and the repository contains no application API route.

The installed PySide6 application is the entire photo-facing product. It has no
network client, telemetry, account, cloud storage, or update service. The fixed
TorchScript LaMa model is included in each installer and must match the expected
SHA-256 before the original workflow can load.

## Photo data flow

1. The user drags JPG, JPEG, or PNG files into the app or chooses them with the
   operating-system multi-select picker.
2. The app creates a new, non-overwriting run folder under the selected
   destination.
3. One worker thread loads the unchanged
   `reference/python-workflow/bulk_timestamp_pipeline.py` entry point and reuses
   its single local LaMa session.
4. Photos are processed sequentially to bound memory use.
5. The original detector requires eight aligned orange glyph components and
   produces a scale-derived timestamp mask.
6. LaMa receives only a padded local crop and its mask. Generated pixels are
   copied back only where the original-resolution mask is true.
7. The workflow writes a lossless PNG, reopens it, and compares the complete
   decoded RGB array with the orientation-normalized input.
8. A result is retained only when every outside-mask pixel is unchanged and no
   eight-glyph timestamp can be redetected.

Every run contains `images/`, `masks/`, `reports/`, and `manifest.json`.
Originals are never renamed, moved, or overwritten. Duplicate basenames receive
numeric suffixes. A failed photo does not abort the rest of the batch, and its
partial artifacts are removed.

## Resource and failure behavior

- One model session is reused; photos do not process in parallel.
- The UI remains responsive because processing runs on a worker thread.
- Cancel means “stop after the current photo”; the active native inference call
  is allowed to finish safely.
- A missing or altered model fails closed before any photo processing begins.
- A disk, decode, detector, inference, or audit error fails only that photo when
  possible and is recorded in the local manifest.
- Packaging is native per target OS because PyInstaller is not a cross-compiler.

## Release boundary

GitHub Actions builds a `.dmg` on Apple Silicon, a separate `.dmg` on Intel, and
a Windows x64 setup `.exe`. Tagged releases also publish `SHA256SUMS.txt`.
Release signing credentials are intentionally not stored in source; trustworthy
public distribution requires configuring Apple notarization and Windows code
signing in the release environment.

## Honest validation boundary

The app invokes the original supplied Python workflow with `method="lama"`; it
is not a TypeScript or ONNX port. Automated repository fixtures are synthetic
and contain no personal imagery. Actual archive-level visual parity still
requires testing the packaged builds with representative original camera files.
