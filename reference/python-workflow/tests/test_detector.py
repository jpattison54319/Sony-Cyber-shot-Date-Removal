from __future__ import annotations

import unittest

import numpy as np

from bulk_timestamp_pipeline import EXPECTED_LAMA_SHA256, detect_timestamp


class DetectorTests(unittest.TestCase):
    def test_synthetic_eight_glyph_date_geometry(self) -> None:
        height, width = 1152, 864
        rgb = np.full((height, width, 3), 80, dtype=np.uint8)
        x_positions = [500, 517, 549, 566, 598, 615, 632, 649]
        for x in x_positions:
            rgb[1020:1046, x : x + 12] = (250, 95, 5)
        core, mask, report = detect_timestamp(rgb)
        self.assertEqual(report["glyph_components"], 8)
        self.assertEqual(len(report["glyph_bboxes_inclusive"]), 8)
        self.assertGreater(int(core.sum()), 0)
        self.assertGreater(int(mask.sum()), int(core.sum()))

    def test_model_digest_is_pinned(self) -> None:
        self.assertEqual(
            EXPECTED_LAMA_SHA256,
            "7ba7aa7ac37a4d41fdbbeba3a2af7ead18058552997e3a3cd1a3b2210c9e6b4c",
        )


if __name__ == "__main__":
    unittest.main()
