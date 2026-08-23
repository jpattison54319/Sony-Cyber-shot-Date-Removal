from __future__ import annotations

import json
import os
import re
import traceback
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png"}
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


@dataclass(frozen=True)
class PhotoTask:
    source: Path
    output: Path
    mask: Path
    report: Path


@dataclass(frozen=True)
class PhotoResult:
    status: str
    source: str
    output: str | None = None
    mask: str | None = None
    report: str | None = None
    error: str | None = None
    traceback: str | None = None
    audit_passed: bool = False


def safe_stem(filename: str) -> str:
    stem = unicodedata.normalize("NFC", Path(filename).stem)
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip(" .")
    stem = re.sub(r"\s+", " ", stem)
    if not stem:
        stem = "photo"
    if stem.upper() in WINDOWS_RESERVED_NAMES:
        stem = f"photo_{stem.lower()}"
    return stem[:100].rstrip(" .") or "photo"


def _candidate_paths(output_root: Path, stem: str) -> tuple[Path, Path, Path]:
    return (
        output_root / "images" / f"{stem}_date_removed.png",
        output_root / "masks" / f"{stem}_timestamp_mask.png",
        output_root / "reports" / f"{stem}_report.json",
    )


def prepare_tasks(sources: Iterable[Path], output_root: Path) -> list[PhotoTask]:
    tasks: list[PhotoTask] = []
    used: set[str] = set()
    for source in sources:
        resolved = source.expanduser().resolve()
        if not resolved.is_file() or resolved.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue

        base = safe_stem(resolved.name)
        suffix = 1
        while True:
            stem = base if suffix == 1 else f"{base}_{suffix}"
            output, mask, report = _candidate_paths(output_root, stem)
            key = stem.casefold()
            if key not in used and not any(path.exists() for path in (output, mask, report)):
                break
            suffix += 1
        used.add(key)
        tasks.append(PhotoTask(resolved, output, mask, report))
    return tasks


def unique_batch_root(parent: Path, now: datetime | None = None) -> Path:
    timestamp = (now or datetime.now()).strftime("%Y-%m-%d %H%M%S")
    base = parent.expanduser().resolve() / f"Date Stamp Cleaner {timestamp}"
    candidate = base
    suffix = 2
    while candidate.exists():
        candidate = Path(f"{base} {suffix}")
        suffix += 1
    return candidate


def _write_manifest(output_root: Path, results: list[PhotoResult]) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = output_root / "manifest.json"
    temporary = output_root / ".manifest.json.tmp"
    payload = {
        "created_at": datetime.now(UTC).isoformat(),
        "method": "lama",
        "total": len(results),
        "succeeded": sum(result.status == "succeeded" for result in results),
        "failed": sum(result.status == "failed" for result in results),
        "canceled": sum(result.status == "canceled" for result in results),
        "results": [asdict(result) for result in results],
    }
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest_path)
    return manifest_path


def process_tasks(
    tasks: list[PhotoTask],
    process_photo: Callable[[Path, Path, Path | None, Path | None, str], dict[str, Any]],
    on_status: Callable[[int, str, str], None],
    should_cancel: Callable[[], bool],
) -> tuple[list[PhotoResult], Path]:
    if not tasks:
        raise ValueError("No supported photos were selected.")
    output_root = tasks[0].output.parent.parent
    for directory in (output_root / "images", output_root / "masks", output_root / "reports"):
        directory.mkdir(parents=True, exist_ok=True)

    results: list[PhotoResult] = []
    for index, task in enumerate(tasks):
        if should_cancel():
            for pending_index in range(index, len(tasks)):
                pending = tasks[pending_index]
                on_status(pending_index, "canceled", "Canceled")
                results.append(PhotoResult(status="canceled", source=str(pending.source)))
            break

        on_status(index, "processing", "Removing date stamp…")
        try:
            report = process_photo(task.source, task.output, task.mask, task.report, "lama")
            audit_passed = bool(
                report.get("outside_mask_rgb_exact")
                and not report.get("timestamp_sequence_redetected")
                and report.get("timestamp_imprint_check_applied")
                and not report.get("timestamp_imprint_detected")
            )
            if not audit_passed:
                raise RuntimeError("The output did not pass the workflow audit.")
            on_status(index, "succeeded", "Verified PNG ready")
            results.append(
                PhotoResult(
                    status="succeeded",
                    source=str(task.source),
                    output=str(task.output),
                    mask=str(task.mask),
                    report=str(task.report),
                    audit_passed=True,
                )
            )
        except Exception as error:  # one bad photo must not abort the batch
            for artifact in (task.output, task.mask, task.report):
                artifact.unlink(missing_ok=True)
            message = str(error).strip() or type(error).__name__
            on_status(index, "failed", message)
            results.append(
                PhotoResult(
                    status="failed",
                    source=str(task.source),
                    error=message,
                    traceback=traceback.format_exc(),
                    audit_passed=False,
                )
            )

    return results, _write_manifest(output_root, results)
