# Desktop application

The native app is a PySide6 interface around the audited
`reference/python-workflow/bulk_timestamp_pipeline.py` processing entry point.
It always calls `process(..., method="lama")`, reuses one local TorchScript
model, processes photos sequentially, and keeps the original PNG, exact mask,
JSON audit report, and batch manifest together.

## Privacy and output

- Photos never leave the computer.
- Originals are never overwritten.
- Failed detections produce no edited output.
- Successful outputs must pass outside-mask exactness, date redetection, and
  connected timestamp-imprint checks. A suspicious result receives bounded
  backend and mask-shape rescue attempts; it fails without an edited output if
  the imprint remains.
- Each run receives a new results folder with `images`, `masks`, `reports`, and
  `manifest.json`.

## Source development

Use Python 3.11 or 3.12. Install Torch separately so Windows receives the CPU
wheel, then install the pinned app dependencies and `simple-lama-inpainting`
without allowing its old dependency ranges to rewrite them.

```bash
python -m pip install torch==2.2.2
python -m pip install -r desktop/requirements-app.txt
python -m pip install --no-deps -r desktop/requirements-original-compat.txt
python desktop/scripts/fetch_model.py
PYTHONPATH=desktop python desktop/run_app.py
```

The model downloader pins the original release URL and refuses bytes that do
not match SHA-256
`7ba7aa7ac37a4d41fdbbeba3a2af7ead18058552997e3a3cd1a3b2210c9e6b4c`.

## Packaging

PyInstaller must run on each target operating system. The release workflow
builds Windows x64, macOS Apple Silicon, and macOS Intel installers. The model
is included inside every installer, so the installed app does not need a model
download or network access.

Public releases should be signed. Without an Apple Developer ID and a Windows
code-signing certificate, Gatekeeper and SmartScreen will warn users even when
the published SHA-256 checksum is correct.
