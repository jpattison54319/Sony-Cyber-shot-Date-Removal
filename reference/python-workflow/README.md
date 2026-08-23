# Audited Camera Timestamp Removal

A production-oriented Python workflow for removing this camera-style orange
`MM DD YYYY` overlay while proving that decoded pixels outside the measured
timestamp mask are unchanged.

This workflow retains the exact detector, mask, primary LaMa inference, and
compositor used on a 164-photo archive, with an additional fail-closed artifact
gate and bounded rescue path:

- 163 timestamps detected and removed.
- 1 undated image safely rejected and left unchanged.
- 163/163 edited images passed PNG, detector, and outside-mask exactness audits.

## What it guarantees

After EXIF orientation normalization, every RGB pixel outside the saved binary
mask is byte-for-byte identical to the source RGB array. Output is lossless PNG
because JPEG recompression would invalidate that guarantee.

Pixels hidden by the timestamp no longer exist in the source. The workflow
cannot recover their historical ground truth; it deterministically reconstructs
only the masked region.

## Pipeline

1. Normalize EXIF orientation into an upright RGB array.
2. Detect eight orange glyphs using color, component, alignment, baseline,
   position, scale, and date-spacing constraints.
3. Dilate the glyph cores by a scale-derived radius to cover the black outline,
   antialiasing, and JPEG ringing.
4. Run a fixed local LaMa model on a crop surrounding the mask.
5. Check for a strong, connected dark imprint repeated around multiple source
   glyphs. If found on an MKLDNN host, retry once with the native CPU backend;
   if needed, run a final inference with rounded glyph boxes that hide the
   digit-shaped mask boundaries from the model.
6. Copy the selected model pixels only where the original binary mask is true.
7. Save lossless PNG, reopen it, verify its structure, compare pixels, and
   require that neither the eight-glyph date nor a strong connected imprint
   remains.
8. Produce JSON reports, masks, manifests, and visual review sheets.

The detector is intentionally specific to this orange camera overlay. The
restoration, compositor, audits, and batch orchestration are reusable. Supporting
another overlay should mean adding a detector profile, not weakening this one.

See [ARCHITECTURE.md](ARCHITECTURE.md) for exact thresholds, invariants, and the
website service boundary.

## Install

Linux CPU reference environment:

```bash
./scripts/install_cpu.sh .venv
export TORCH_HOME="$PWD/.torch-cache"
```

The first LaMa run downloads `big-lama.pt`. The application checks the model
against this SHA-256 before inference:

```text
7ba7aa7ac37a4d41fdbbeba3a2af7ead18058552997e3a3cd1a3b2210c9e6b4c
```

For production, pre-stage the verified file and set `LAMA_MODEL` to its absolute
path. Do not depend on a runtime model download in ephemeral web workers.

## One image

```bash
.venv/bin/python bulk_timestamp_pipeline.py input.jpg output.png \
  --mask-output mask.png \
  --report-output report.json \
  --method lama
```

## Folder

```bash
.venv/bin/python batch_timestamp_folder.py input_folder output_folder \
  --workers 2 \
  --method lama \
  --manifest output_folder/manifest.json
```

## Detection-only preflight

```bash
.venv/bin/python preflight_timestamp_archive.py input_folder preflight.json
```

## Audit and review

```bash
.venv/bin/python audit_timestamp_batch.py \
  output_folder/manifest.json output_folder/final_audit.json

.venv/bin/python make_timestamp_review_sheet.py \
  output_folder/manifest.json review.png --columns 4
```

Known-good before/after pairs can be checked with the same production gates:

```bash
.venv/bin/python tools/evaluate_golden_pair.py source.jpg approved.png \
  --fail-on-rejection
```

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -v
```

## Website handoff

Read [WEB_HANDOFF.md](WEB_HANDOFF.md) before exposing this as a service. In
particular, keep the worker asynchronous, retain masks/reports, reject detector
failures rather than guessing, strip untrusted filenames, set upload limits,
and never claim historical-pixel recovery.

## Files

- `bulk_timestamp_pipeline.py` — detector, mask, reconstruction, compositor,
  and per-image verification.
- `batch_timestamp_folder.py` — multiprocessing folder runner and manifest.
- `preflight_timestamp_archive.py` — detection-only scan.
- `audit_timestamp_batch.py` — fail-closed batch audit.
- `tools/evaluate_golden_pair.py` — regression check for approved before/after pairs.
- `make_timestamp_review_sheet.py` — before/after crop sheets.
- `tools/materialize_drive_b64.py` — optional connector-stream bridge used in
  the original Drive ingestion; not required by the image algorithm.

The LaMa model weights are intentionally not included.
