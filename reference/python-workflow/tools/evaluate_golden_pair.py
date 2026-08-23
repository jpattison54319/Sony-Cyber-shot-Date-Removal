#!/usr/bin/env python3
"""Compare one known-good output with its source using production gates."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bulk_timestamp_pipeline import (  # noqa: E402
    detect_timestamp,
    orange_core,
    timestamp_imprint_metrics,
)


def evaluate(source_path: Path, golden_path: Path) -> dict[str, object]:
    with Image.open(source_path) as opened:
        source = np.asarray(ImageOps.exif_transpose(opened).convert("RGB"))
    with Image.open(golden_path) as opened:
        golden = np.asarray(opened.convert("RGB"))
    if source.shape != golden.shape:
        raise ValueError(
            f"canonical shape mismatch: source={source.shape}, golden={golden.shape}"
        )

    core, mask, detection = detect_timestamp(source)
    changed = np.any(source != golden, axis=2)
    outside = changed & ~mask
    remaining_orange = orange_core(golden) & mask
    imprint = timestamp_imprint_metrics(
        source,
        golden,
        core,
        mask,
        detection["glyph_bboxes_inclusive"],
        float(detection["mask_radius"]),
    )
    try:
        detect_timestamp(golden)
        redetected = True
    except RuntimeError:
        redetected = False
    accepted = bool(
        not outside.any()
        and not redetected
        and not imprint["detected"]
    )
    return {
        "source": str(source_path),
        "golden": str(golden_path),
        "accepted": accepted,
        "changed_pixels": int(changed.sum()),
        "changed_pixels_outside_mask": int(outside.sum()),
        "remaining_orange_core_pixels_inside_mask": int(remaining_orange.sum()),
        "timestamp_sequence_redetected": redetected,
        "timestamp_imprint": imprint,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("golden", type=Path)
    parser.add_argument("--fail-on-rejection", action="store_true")
    parser.add_argument("--summary-only", action="store_true")
    args = parser.parse_args()
    report = evaluate(args.source, args.golden)
    payload = report
    if args.summary_only:
        imprint = report["timestamp_imprint"]
        payload = {
            "accepted": report["accepted"],
            "changed_pixels_outside_mask": report["changed_pixels_outside_mask"],
            "remaining_orange_core_pixels_inside_mask": report[
                "remaining_orange_core_pixels_inside_mask"
            ],
            "timestamp_sequence_redetected": report["timestamp_sequence_redetected"],
            "imprint_detected": imprint["detected"],
            "imprint_fraction": imprint["residual_fraction"],
            "imprint_affected_glyphs": imprint["affected_glyphs"],
            "imprint_coherent_fraction": imprint["coherent_fraction"],
            "imprint_coherent_glyphs": imprint["coherent_glyphs"],
        }
    print(json.dumps(payload, separators=(",", ":")))
    if args.fail_on_rejection and not report["accepted"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
