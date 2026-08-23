# Date Stamp Cleaner

Date Stamp Cleaner is a private macOS and Windows app for removing the orange
`MM DD YYYY` date added by many Sony Cyber-shot cameras. It wraps the original
validated Python + LaMa workflow rather than approximating it in a browser.

The [project website](https://sony-cyber-shot-date-removal.vercel.app) only
distributes installers. Photo selection and processing happen inside the
desktop app; the site has no upload control, backend, account, analytics, or
photo storage.

## Desktop behavior

- Drag and drop or multi-select JPG, JPEG, and PNG photos.
- Process a single image or a batch, sequentially, with one reused local model.
- Keep every original untouched.
- Save successful results as lossless PNGs in a new run folder.
- Retain the exact timestamp mask, per-photo audit report, and batch manifest.
- Reject a result if the workflow detects a changed pixel outside the mask,
  redetects the timestamp, or finds a strong connected glyph-shaped imprint
  after its bounded rescue pass.

The covered scene cannot be historically recovered. LaMa reconstructs that
small area; the exactness guarantee applies to decoded RGB pixels outside the
recorded mask.

## Run from source

Python 3.11 is used for packaged releases.

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
python -m pip install torch==2.2.2
python -m pip install -r desktop/requirements-app.txt
python -m pip install --no-deps -r desktop/requirements-original-compat.txt
python desktop/scripts/fetch_model.py
PYTHONPATH=desktop python desktop/run_app.py
```

The model downloader checks the original model against its pinned SHA-256
before it becomes usable. The installed app includes those verified weights and
does not download anything at runtime.

## Validation and installers

```bash
npm ci
npm test
npm run lint
npm run typecheck
npm run audit:privacy
npm run build
PYTHONPATH=desktop python -m unittest discover -s desktop/tests -v
```

`.github/workflows/desktop-release.yml` builds each platform on its own OS:
macOS Apple Silicon, macOS Intel, and Windows x64. A `v*` tag publishes the
three installers and a SHA-256 checksum file to GitHub Releases.

Public installers should be code-signed. Unsigned macOS and Windows builds can
trigger Gatekeeper or SmartScreen even when their checksums are valid.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the privacy boundary and
[desktop/README.md](desktop/README.md) for packaging details.

## Project map

- `desktop/` — native PySide6 interface, batch controller, tests, and packaging.
- `reference/python-workflow/` — original Python detector and compositor plus
  the hardened reconstruction audit used directly by the app.
- `app/` and `components/download-app.tsx` — static installer download site.
- `.github/workflows/desktop-release.yml` — per-platform installer builds.

Sony and Cyber-shot are trademarks of their respective owner. This independent
project uses the names only to describe compatible camera timestamps.
