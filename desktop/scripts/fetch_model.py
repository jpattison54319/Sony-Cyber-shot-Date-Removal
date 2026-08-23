from __future__ import annotations

import argparse
import hashlib
import os
import sys
import tempfile
import urllib.request
from pathlib import Path


MODEL_URL = (
    "https://github.com/enesmsahin/simple-lama-inpainting/"
    "releases/download/v0.1.0/big-lama.pt"
)
MODEL_SHA256 = "7ba7aa7ac37a4d41fdbbeba3a2af7ead18058552997e3a3cd1a3b2210c9e6b4c"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_model(destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and sha256_file(destination) == MODEL_SHA256:
        print(f"Verified existing model: {destination}")
        return destination

    with tempfile.NamedTemporaryFile(
        prefix="big-lama-",
        suffix=".download",
        dir=destination.parent,
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)

    try:
        digest = hashlib.sha256()
        request = urllib.request.Request(MODEL_URL, headers={"User-Agent": "DateStampCleanerBuild/0.1"})
        with urllib.request.urlopen(request, timeout=60) as response, temporary_path.open("wb") as output:
            total = int(response.headers.get("Content-Length", "0"))
            received = 0
            next_report = 10
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                digest.update(chunk)
                received += len(chunk)
                if total:
                    percent = int(received * 100 / total)
                    if percent >= next_report:
                        print(f"Model download: {percent}%")
                        next_report += 10
        if digest.hexdigest() != MODEL_SHA256:
            raise RuntimeError("Downloaded LaMa model failed its SHA-256 integrity check.")
        os.replace(temporary_path, destination)
    finally:
        temporary_path.unlink(missing_ok=True)

    print(f"Downloaded and verified model: {destination}")
    return destination


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "models" / "big-lama.pt",
    )
    args = parser.parse_args()
    try:
        fetch_model(args.output.expanduser().resolve())
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
