from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from date_stamp_cleaner.batch import prepare_tasks, process_tasks, safe_stem, unique_batch_root


class BatchTests(unittest.TestCase):
    def test_safe_stem_handles_cross_platform_names(self) -> None:
        self.assertEqual(safe_stem("../CON.jpg"), "photo_con")
        self.assertEqual(safe_stem('trip:day?1.jpg'), "trip_day_1")
        self.assertEqual(safe_stem(".jpg"), "jpg")

    def test_duplicate_stems_receive_unique_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first_dir = root / "a"
            second_dir = root / "b"
            first_dir.mkdir()
            second_dir.mkdir()
            first = first_dir / "photo.jpg"
            second = second_dir / "photo.jpg"
            first.write_bytes(b"one")
            second.write_bytes(b"two")
            tasks = prepare_tasks([first, second], root / "results")
            self.assertEqual(tasks[0].output.name, "photo_date_removed.png")
            self.assertEqual(tasks[1].output.name, "photo_2_date_removed.png")

    def test_process_tasks_keeps_failures_out_of_results(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            good = root / "good.jpg"
            bad = root / "bad.jpg"
            good.write_bytes(b"good")
            bad.write_bytes(b"bad")
            tasks = prepare_tasks([good, bad], root / "results")
            statuses: list[tuple[int, str]] = []

            def fake_process(source, output, mask, report, method):  # type: ignore[no-untyped-def]
                self.assertEqual(method, "lama")
                output.parent.mkdir(parents=True, exist_ok=True)
                mask.parent.mkdir(parents=True, exist_ok=True)
                report.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b"png")
                mask.write_bytes(b"mask")
                report.write_text("{}")
                if source.name == "bad.jpg":
                    raise RuntimeError("date not found")
                return {
                    "outside_mask_rgb_exact": True,
                    "timestamp_sequence_redetected": False,
                    "remaining_orange_core_pixels_inside_mask": 0,
                    "timestamp_imprint_check_applied": True,
                    "timestamp_imprint_detected": False,
                }

            results, manifest = process_tasks(
                tasks,
                fake_process,
                lambda index, status, _detail: statuses.append((index, status)),
                lambda: False,
            )
            self.assertEqual([result.status for result in results], ["succeeded", "failed"])
            self.assertTrue(tasks[0].output.exists())
            self.assertFalse(tasks[1].output.exists())
            payload = json.loads(manifest.read_text())
            self.assertEqual(payload["succeeded"], 1)
            self.assertEqual(payload["failed"], 1)
            self.assertIn((1, "failed"), statuses)

    def test_process_tasks_rejects_a_visual_residue_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "photo.jpg"
            source.write_bytes(b"photo")
            tasks = prepare_tasks([source], root / "results")

            def fake_process(_source, output, mask, report, _method):  # type: ignore[no-untyped-def]
                for artifact in (output, mask, report):
                    artifact.parent.mkdir(parents=True, exist_ok=True)
                    artifact.write_bytes(b"artifact")
                return {
                    "outside_mask_rgb_exact": True,
                    "timestamp_sequence_redetected": False,
                    "remaining_orange_core_pixels_inside_mask": 0,
                    "timestamp_imprint_check_applied": True,
                    "timestamp_imprint_detected": True,
                }

            results, _ = process_tasks(
                tasks,
                fake_process,
                lambda *_args: None,
                lambda: False,
            )
            self.assertEqual(results[0].status, "failed")
            self.assertIn("workflow audit", results[0].error or "")
            self.assertFalse(tasks[0].output.exists())
            self.assertFalse(tasks[0].mask.exists())
            self.assertFalse(tasks[0].report.exists())

    def test_process_tasks_allows_nondatelike_orange_scene_pixels(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "photo.jpg"
            source.write_bytes(b"photo")
            tasks = prepare_tasks([source], root / "results")

            def fake_process(_source, output, mask, report, _method):  # type: ignore[no-untyped-def]
                for artifact in (output, mask, report):
                    artifact.parent.mkdir(parents=True, exist_ok=True)
                    artifact.write_bytes(b"artifact")
                return {
                    "outside_mask_rgb_exact": True,
                    "timestamp_sequence_redetected": False,
                    "remaining_orange_core_pixels_inside_mask": 26011,
                    "timestamp_imprint_check_applied": True,
                    "timestamp_imprint_detected": False,
                }

            results, _ = process_tasks(
                tasks,
                fake_process,
                lambda *_args: None,
                lambda: False,
            )
            self.assertEqual(results[0].status, "succeeded")
            self.assertTrue(results[0].audit_passed)

    def test_batch_root_is_predictable_and_non_overwriting(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            moment = datetime(2026, 8, 23, 14, 30, 0)
            first = unique_batch_root(parent, moment)
            first.mkdir()
            second = unique_batch_root(parent, moment)
            self.assertEqual(second.name, "Date Stamp Cleaner 2026-08-23 143000 2")


if __name__ == "__main__":
    unittest.main()
