from __future__ import annotations

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules


desktop_root = Path(SPECPATH).resolve()
project_root = desktop_root.parent
workflow_root = project_root / "reference" / "python-workflow"
model_path = Path(os.environ.get("DATE_STAMP_MODEL_PATH", desktop_root / "models" / "big-lama.pt"))
app_version = os.environ.get("DATE_STAMP_APP_VERSION", "0.1.0").removeprefix("v")
if not model_path.is_file():
    raise SystemExit("Run desktop/scripts/fetch_model.py before packaging.")

icon_path = desktop_root / "assets" / ("app-icon.icns" if sys.platform == "darwin" else "app-icon.ico")
hidden_imports = [
    "bulk_timestamp_pipeline",
    *collect_submodules("simple_lama_inpainting"),
]

analysis = Analysis(
    [str(desktop_root / "run_app.py")],
    pathex=[str(desktop_root), str(workflow_root)],
    binaries=[],
    datas=[(str(model_path), "models")],
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["matplotlib"],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(analysis.pure)
executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="Date Stamp Cleaner",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=os.environ.get("APPLE_CODESIGN_IDENTITY") or None,
    entitlements_file=None,
    icon=str(icon_path) if icon_path.is_file() else None,
)
collection = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Date Stamp Cleaner",
)

if sys.platform == "darwin":
    app = BUNDLE(
        collection,
        name="Date Stamp Cleaner.app",
        icon=str(icon_path) if icon_path.is_file() else None,
        bundle_identifier="com.jpattison.datestampcleaner",
        version=app_version,
        info_plist={
            "CFBundleDisplayName": "Date Stamp Cleaner",
            "NSHighResolutionCapable": True,
            "LSApplicationCategoryType": "public.app-category.photography",
        },
    )
