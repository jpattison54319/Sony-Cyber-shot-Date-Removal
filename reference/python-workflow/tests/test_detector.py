from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image
from scipy import ndimage

from bulk_timestamp_pipeline import (
    EXPECTED_LAMA_SHA256,
    detect_timestamp,
    disk,
    process,
    restore,
    rounded_glyph_rescue_mask,
    timestamp_imprint_metrics,
)


def synthetic_timestamp_scene() -> np.ndarray:
    height, width = 1152, 864
    rgb = np.full((height, width, 3), 112, dtype=np.uint8)
    x_positions = [500, 517, 549, 566, 598, 615, 632, 649]
    for x in x_positions:
        rgb[1016:1050, x - 4 : x + 16] = (4, 4, 4)
        rgb[1020:1046, x : x + 12] = (250, 95, 5)
    return rgb


class DetectorTests(unittest.TestCase):
    def test_synthetic_eight_glyph_date_geometry(self) -> None:
        rgb = synthetic_timestamp_scene()
        core, mask, report = detect_timestamp(rgb)
        self.assertEqual(report["glyph_components"], 8)
        self.assertEqual(len(report["glyph_bboxes_inclusive"]), 8)
        self.assertGreater(int(core.sum()), 0)
        self.assertGreater(int(mask.sum()), int(core.sum()))

    def test_timestamp_imprint_check_rejects_repeated_dark_glyph_outlines(self) -> None:
        source = synthetic_timestamp_scene()
        core, mask, report = detect_timestamp(source)
        clean = source.copy()
        clean[mask] = (112, 112, 112)
        clean_metrics = timestamp_imprint_metrics(
            source,
            clean,
            core,
            mask,
            report["glyph_bboxes_inclusive"],
            float(report["mask_radius"]),
        )
        self.assertFalse(clean_metrics["detected"])

        contaminated = clean.copy()
        outline = (
            ndimage.binary_dilation(
                core,
                structure=disk(max(2.0, float(report["mask_radius"]))),
            )
            & ~core
            & mask
        )
        contaminated[outline] = source[outline]
        contaminated_metrics = timestamp_imprint_metrics(
            source,
            contaminated,
            core,
            mask,
            report["glyph_bboxes_inclusive"],
            float(report["mask_radius"]),
        )
        self.assertTrue(contaminated_metrics["detected"])
        self.assertGreaterEqual(contaminated_metrics["affected_glyphs"], 3)

    def test_rescue_mask_is_bounded_and_hides_glyph_holes(self) -> None:
        source = synthetic_timestamp_scene()
        _, mask, report = detect_timestamp(source)
        rescue = rounded_glyph_rescue_mask(
            mask,
            report["glyph_bboxes_inclusive"],
            float(report["mask_radius"]),
        )
        self.assertTrue(np.all(rescue[mask]))
        self.assertGreater(int(rescue.sum()), int(mask.sum()))
        self.assertLessEqual(int(rescue.sum()), int(mask.sum()) * 3)
        for x0, y0, x1, y1 in report["glyph_bboxes_inclusive"]:
            self.assertTrue(rescue[(y0 + y1) // 2, (x0 + x1) // 2])

    def test_classical_processing_records_the_visual_residue_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.png"
            output = root / "output.png"
            mask = root / "mask.png"
            report_path = root / "report.json"
            Image.fromarray(synthetic_timestamp_scene(), mode="RGB").save(source)
            report = process(source, output, mask, report_path, method="harmonic")
            self.assertTrue(report["timestamp_imprint_check_applied"])
            self.assertFalse(report["timestamp_imprint_detected"])
            self.assertEqual(report["remaining_orange_core_pixels_inside_mask"], 0)
            self.assertTrue(report["outside_mask_rgb_exact"])

    def test_lama_rescue_replaces_a_detected_glyph_imprint(self) -> None:
        source = synthetic_timestamp_scene()
        core, mask, detection = detect_timestamp(source)

        class FakeLama:
            calls = 0

            def __call__(self, image, _mask):  # type: ignore[no-untyped-def]
                type(self).calls += 1
                if type(self).calls <= 2:
                    return image.copy()
                clean = np.full((image.height, image.width, 3), 112, dtype=np.uint8)
                return Image.fromarray(clean, mode="RGB")

        fake_torch = types.ModuleType("torch")
        fake_torch.manual_seed = lambda _seed: None  # type: ignore[attr-defined]
        fake_torch.set_num_threads = lambda _count: None  # type: ignore[attr-defined]
        fake_torch.use_deterministic_algorithms = lambda _enabled: None  # type: ignore[attr-defined]
        fake_torch.hub = types.SimpleNamespace(get_dir=lambda: "/unused")  # type: ignore[attr-defined]
        fake_mkldnn = types.SimpleNamespace(
            enabled=True,
            is_available=lambda: True,
        )
        fake_torch.backends = types.SimpleNamespace(mkldnn=fake_mkldnn)  # type: ignore[attr-defined]
        fake_lama_module = types.ModuleType("simple_lama_inpainting")
        fake_lama_module.SimpleLama = FakeLama  # type: ignore[attr-defined]

        with tempfile.TemporaryDirectory() as temporary:
            model = Path(temporary) / "big-lama.pt"
            model.write_bytes(b"verified fake model")
            digest = hashlib.sha256(model.read_bytes()).hexdigest()
            import bulk_timestamp_pipeline as pipeline

            previous = (
                pipeline._LAMA_MODEL,
                pipeline._LAMA_MODEL_PATH,
                pipeline._LAMA_MODEL_SHA256,
            )
            pipeline._LAMA_MODEL = None
            pipeline._LAMA_MODEL_PATH = None
            pipeline._LAMA_MODEL_SHA256 = None
            FakeLama.calls = 0
            try:
                with (
                    mock.patch.dict(
                        sys.modules,
                        {
                            "torch": fake_torch,
                            "simple_lama_inpainting": fake_lama_module,
                        },
                    ),
                    mock.patch.dict(os.environ, {"LAMA_MODEL": str(model)}),
                    mock.patch.object(pipeline, "EXPECTED_LAMA_SHA256", digest),
                ):
                    result, report = restore(
                        source,
                        mask,
                        float(detection["mask_radius"]),
                        forced_method="lama",
                        core=core,
                        glyph_bboxes=detection["glyph_bboxes_inclusive"],
                    )
            finally:
                (
                    pipeline._LAMA_MODEL,
                    pipeline._LAMA_MODEL_PATH,
                    pipeline._LAMA_MODEL_SHA256,
                ) = previous

        self.assertEqual(FakeLama.calls, 3)
        self.assertEqual(report["chosen_method"], "lama_rescue")
        self.assertTrue(report["timestamp_imprint_rescue_used"])
        self.assertTrue(report["timestamp_imprint_native_cpu_metrics"]["detected"])
        self.assertFalse(report["timestamp_imprint_detected"])
        self.assertTrue(fake_mkldnn.enabled)
        self.assertTrue(np.all(result[mask] == 112))
        self.assertTrue(np.array_equal(result[~mask], source[~mask]))

    def test_model_digest_is_pinned(self) -> None:
        self.assertEqual(
            EXPECTED_LAMA_SHA256,
            "7ba7aa7ac37a4d41fdbbeba3a2af7ead18058552997e3a3cd1a3b2210c9e6b4c",
        )


if __name__ == "__main__":
    unittest.main()
