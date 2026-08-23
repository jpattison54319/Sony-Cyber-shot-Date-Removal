#!/usr/bin/env bash
set -euo pipefail

venv_path="${1:-.venv}"
python3 -m venv "$venv_path"
"$venv_path/bin/pip" install --disable-pip-version-check \
  --index-url https://download.pytorch.org/whl/cpu \
  torch==2.2.2
"$venv_path/bin/pip" install --disable-pip-version-check \
  -r "$(dirname "$0")/../requirements-core.txt"
# simple-lama 0.1.2 declares older Pillow/OpenCV bounds although its runtime
# code works with the pinned wheels above. Install without dependency rewriting.
"$venv_path/bin/pip" install --disable-pip-version-check --no-deps \
  simple-lama-inpainting==0.1.2

echo "Environment created at $venv_path"

