#!/usr/bin/env bash
set -euo pipefail

desktop_root="$(cd "$(dirname "$0")/.." && pwd)"
project_root="$(cd "$desktop_root/.." && pwd)"
model_path="$desktop_root/models/big-lama.pt"

if [[ ! -f "$desktop_root/DateStampCleaner.spec" || ! -d "$project_root/reference/python-workflow" ]]; then
  echo "Refusing to build outside the Date Stamp Cleaner source tree." >&2
  exit 1
fi

app_version="${DATE_STAMP_APP_VERSION:-0.1.0}"
export DATE_STAMP_APP_VERSION="${app_version#v}"

python "$desktop_root/scripts/fetch_model.py" --output "$model_path"
python "$desktop_root/scripts/generate_icons.py"

rm -rf "$desktop_root/build" "$desktop_root/dist" "$desktop_root/release"
mkdir -p "$desktop_root/release"

DATE_STAMP_MODEL_PATH="$model_path" pyinstaller \
  --noconfirm \
  --clean \
  --workpath "$desktop_root/build" \
  --distpath "$desktop_root/dist" \
  "$desktop_root/DateStampCleaner.spec"

"$desktop_root/dist/Date Stamp Cleaner.app/Contents/MacOS/Date Stamp Cleaner" --self-check

architecture="$(uname -m)"
if [[ "$architecture" == "arm64" ]]; then
  artifact_name="DateStampCleaner-macOS-Apple-Silicon.dmg"
else
  artifact_name="DateStampCleaner-macOS-Intel.dmg"
fi

dmg_root="$desktop_root/build/dmg-root"
mkdir -p "$dmg_root"
cp -R "$desktop_root/dist/Date Stamp Cleaner.app" "$dmg_root/"
ln -s /Applications "$dmg_root/Applications"
hdiutil create \
  -volname "Date Stamp Cleaner" \
  -srcfolder "$dmg_root" \
  -ov \
  -format UDZO \
  "$desktop_root/release/$artifact_name"

shasum -a 256 "$desktop_root/release/$artifact_name"
