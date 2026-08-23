from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QFrame

from date_stamp_cleaner.app import THEME, MainWindow, apply_application_theme
from date_stamp_cleaner.batch import PhotoResult


def _relative_luminance(color: str) -> float:
    channels = [int(color[index : index + 2], 16) / 255 for index in (1, 3, 5)]
    linear = [
        value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4
        for value in channels
    ]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _contrast_ratio(first: str, second: str) -> float:
    lighter, darker = sorted(
        (_relative_luminance(first), _relative_luminance(second)),
        reverse=True,
    )
    return (lighter + 0.05) / (darker + 0.05)


class MainWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QApplication.instance() or QApplication([])
        apply_application_theme(cls.application)

    def setUp(self) -> None:
        self.window = MainWindow()

    def tearDown(self) -> None:
        self.window.close()
        self.application.processEvents()

    def _add_photo(self, directory: str, name: str = "photo.jpg") -> Path:
        photo = Path(directory) / name
        photo.write_bytes(b"photo")
        self.window.add_photos([photo])
        return photo

    def test_selected_failed_row_shows_persistent_details(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            self._add_photo(temporary)
            self.window._set_row_status(0, "failed", "No date stamp was found.")
            self.window.table.selectRow(0)
            self.application.processEvents()

            self.assertFalse(self.window.detail_panel.isHidden())
            self.assertEqual(self.window.detail_title.text(), "photo.jpg · Failed")
            self.assertEqual(self.window.detail_body.text(), "No date stamp was found.")
            self.assertEqual(self.window.detail_panel.property("kind"), "error")

    def test_clicking_an_already_selected_row_replaces_batch_details(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            photo = self._add_photo(temporary)
            error = "No date stamp was found."
            self.window._set_row_status(0, "failed", error)
            self.window.table.selectRow(0)
            self.window._processing_completed(
                [PhotoResult(status="failed", source=str(photo), error=error)],
                str(Path(temporary) / "manifest.json"),
            )
            self.assertEqual(self.window.detail_title.text(), "1 photo failed")

            self.window.table.cellClicked.emit(0, 0)

            self.assertEqual(self.window.detail_title.text(), "photo.jpg · Failed")
            self.assertEqual(self.window.detail_body.text(), error)

    def test_common_failure_is_shown_without_selecting_a_row(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            first = self._add_photo(temporary, "first.jpg")
            second = self._add_photo(temporary, "second.jpg")
            error = "No date stamp was found."
            self.window._processing_completed(
                [
                    PhotoResult(status="failed", source=str(first), error=error),
                    PhotoResult(status="failed", source=str(second), error=error),
                ],
                str(Path(temporary) / "manifest.json"),
            )

            self.assertFalse(self.window.detail_panel.isHidden())
            self.assertEqual(self.window.detail_title.text(), "2 photos failed")
            self.assertEqual(self.window.detail_body.text(), error)
            self.assertEqual(
                self.window.status_label.text(),
                "No photos cleaned.",
            )

    def test_theme_has_explicit_title_table_and_disabled_button_colors(self) -> None:
        style = self.window.styleSheet()
        self.assertIn(f"QLabel#title {{ color: {THEME['text']};", style)
        self.assertIn(f"QTableWidget {{ color: {THEME['text']};", style)
        self.assertIn(f"QTableWidget::item:selected {{ color: {THEME['text']};", style)
        self.assertIn("QPushButton#primaryButton:disabled", style)

    def test_interface_avoids_decorative_badges_and_proof_strips(self) -> None:
        style = self.window.styleSheet()
        self.assertNotIn("localBadge", style)
        self.assertNotIn("trustStrip", style)
        self.assertNotIn("brandMark", style)
        self.assertEqual(self.window.count_label.text(), "Photos (0)")
        self.assertEqual(self.window.status_label.text(), "Ready")

    def test_error_details_do_not_hide_the_output_destination(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            self._add_photo(temporary)
            self.window._set_row_status(0, "failed", "No date stamp was found.")
            self.window.show()
            self.application.processEvents()

            destination = self.window.findChild(QFrame, "destination")
            self.assertIsNotNone(destination)
            self.assertTrue(destination.isVisible())
            self.assertGreaterEqual(destination.height(), 44)

    def test_essential_theme_pairings_meet_wcag_contrast(self) -> None:
        self.assertGreaterEqual(_contrast_ratio(THEME["text"], THEME["canvas"]), 7.0)
        self.assertGreaterEqual(_contrast_ratio(THEME["text"], THEME["surface"]), 7.0)
        self.assertGreaterEqual(_contrast_ratio(THEME["text_muted"], THEME["surface"]), 4.5)
        self.assertGreaterEqual(_contrast_ratio(THEME["text_on_primary"], THEME["primary"]), 7.0)

    def test_window_cannot_resize_below_complete_layout(self) -> None:
        self.assertGreaterEqual(self.window.minimumWidth(), 760)
        self.assertGreaterEqual(self.window.minimumHeight(), 680)


if __name__ == "__main__":
    unittest.main()
