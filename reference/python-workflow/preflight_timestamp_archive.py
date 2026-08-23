#!/usr/bin/env python3
"""Detection-only preflight for a folder of timestamped JPEGs."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from bulk_timestamp_pipeline import detect_timestamp


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    rows: list[dict[str, object]] = []
    for path in sorted(args.input_dir.glob("*.jpg")):
        row: dict[str, object] = {"input": str(path), "bytes": path.stat().st_size}
        try:
            with Image.open(path) as opened:
                orientation = int(opened.getexif().get(274, 1))
                rgb = np.asarray(ImageOps.exif_transpose(opened).convert("RGB"))
            _, mask, detection = detect_timestamp(rgb)
            row.update(
                status="detected",
                canonical_dimensions=[int(rgb.shape[1]), int(rgb.shape[0])],
                exif_orientation=orientation,
                **detection,
            )
        except Exception as error:
            row.update(status="failed", error=str(error))
        row["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append(row)
        print(json.dumps({"completed": len(rows), "status": row["status"], "input": str(path)}))
    report = {
        "input_dir": str(args.input_dir.resolve()),
        "total": len(rows),
        "detected": sum(row["status"] == "detected" for row in rows),
        "failed": sum(row["status"] == "failed" for row in rows),
        "results": rows,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("total", "detected", "failed")}))


if __name__ == "__main__":
    main()
