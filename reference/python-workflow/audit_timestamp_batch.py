#!/usr/bin/env python3
"""Fail-closed structural and report audit for a completed timestamp batch."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    rows: list[dict[str, object]] = []
    model_hashes: set[str] = set()
    for item in manifest["results"]:
        if item["status"] != "succeeded":
            rows.append({"input": item["input"], "status": "skipped", "reason": item["error"]})
            continue
        report = json.loads(Path(item["report"]).read_text())
        errors: list[str] = []
        try:
            with Image.open(item["output"]) as image:
                image.verify()
        except Exception as error:
            errors.append(f"PNG verify failed: {error}")
        if report["changed_pixels_outside_mask"] != 0:
            errors.append("outside-mask pixels changed")
        if not report["outside_mask_rgb_exact"]:
            errors.append("outside-mask exactness flag is false")
        if report["timestamp_sequence_redetected"]:
            errors.append("timestamp sequence redetected")
        if not report.get("timestamp_imprint_check_applied"):
            errors.append("timestamp imprint check was not applied")
        if report.get("timestamp_imprint_detected"):
            errors.append("possible dark timestamp outline detected")
        model_hash = report.get("inpainting_model_sha256")
        if model_hash:
            model_hashes.add(model_hash)
        rows.append(
            {
                "input": item["input"],
                "output": item["output"],
                "status": "passed" if not errors else "failed",
                "errors": errors,
                "mask_pixels": report["mask_pixels"],
                "orange_threshold_pixels_inside_mask_after": report[
                    "remaining_orange_core_pixels_inside_mask"
                ],
                "timestamp_imprint_detected": report.get("timestamp_imprint_detected"),
                "timestamp_imprint_rescue_used": report.get(
                    "timestamp_imprint_rescue_used", False
                ),
                "edited_area_percent": report["edited_area_percent"],
                "input_sha256": report["input_sha256"],
                "output_sha256": report["output_sha256"],
            }
        )
    audit = {
        "manifest": str(args.manifest.resolve()),
        "total_manifest_items": len(manifest["results"]),
        "passed": sum(row["status"] == "passed" for row in rows),
        "failed": sum(row["status"] == "failed" for row in rows),
        "skipped": sum(row["status"] == "skipped" for row in rows),
        "model_sha256_values": sorted(model_hashes),
        "all_outputs_png_structurally_valid": not any(row["status"] == "failed" for row in rows),
        "all_successes_outside_mask_rgb_exact": not any(row["status"] == "failed" for row in rows),
        "results": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(audit, indent=2) + "\n")
    print(json.dumps({key: audit[key] for key in ("passed", "failed", "skipped")}, indent=2))
    if audit["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
