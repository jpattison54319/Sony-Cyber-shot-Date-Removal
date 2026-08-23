#!/usr/bin/env python3
"""Run the deterministic timestamp remover over a local folder of JPEGs."""

from __future__ import annotations

import argparse
import json
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from bulk_timestamp_pipeline import process


EXTENSIONS = {".jpg", ".jpeg", ".JPG", ".JPEG"}


def run_one(
    input_path: Path,
    output_dir: Path,
    mask_dir: Path,
    report_dir: Path,
    method: str,
) -> dict[str, object]:
    stem = input_path.stem
    output = output_dir / f"{stem}_date_removed.png"
    mask = mask_dir / f"{stem}_timestamp_mask.png"
    report = report_dir / f"{stem}_report.json"
    try:
        data = process(input_path, output, mask, report, method)
        return {
            "status": "succeeded",
            "input": str(input_path),
            "output": str(output),
            "mask": str(mask),
            "report": str(report),
            "chosen_method": data["chosen_method"],
            "detector_score": data["detector_score"],
            "edited_area_percent": data["edited_area_percent"],
            "outside_mask_rgb_exact": data["outside_mask_rgb_exact"],
        }
    except Exception as error:  # retain a complete manifest instead of aborting the batch
        return {
            "status": "failed",
            "input": str(input_path),
            "error": str(error),
            "traceback": traceback.format_exc(),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument(
        "--method",
        choices=(
            "auto",
            "harmonic",
            "harmonic_texture",
            "edge_guided",
            "bilateral",
            "edge_weighted",
            "edge_weighted_texture",
            "lama",
        ),
        default="harmonic",
    )
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()

    inputs = sorted(
        path for path in args.input_dir.iterdir() if path.is_file() and path.suffix in EXTENSIONS
    )
    if not inputs:
        raise SystemExit(f"no JPEG files found in {args.input_dir}")

    output_dir = args.output_dir / "images"
    mask_dir = args.output_dir / "masks"
    report_dir = args.output_dir / "reports"
    for directory in (output_dir, mask_dir, report_dir):
        directory.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, object]] = []
    with ProcessPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {
            pool.submit(run_one, path, output_dir, mask_dir, report_dir, args.method): path
            for path in inputs
        }
        for completed, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            results.append(result)
            print(
                json.dumps(
                    {
                        "completed": completed,
                        "total": len(inputs),
                        "status": result["status"],
                        "input": result["input"],
                    }
                ),
                flush=True,
            )

    results.sort(key=lambda item: str(item["input"]))
    manifest = {
        "input_dir": str(args.input_dir.resolve()),
        "output_dir": str(args.output_dir.resolve()),
        "method": args.method,
        "total": len(results),
        "succeeded": sum(item["status"] == "succeeded" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
        "results": results,
    }
    manifest_path = args.manifest or args.output_dir / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({key: manifest[key] for key in ("total", "succeeded", "failed")}, indent=2))


if __name__ == "__main__":
    main()
