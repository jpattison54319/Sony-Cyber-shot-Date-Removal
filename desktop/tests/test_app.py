from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from date_stamp_cleaner.app import MainWindow
from date_stamp_cleaner.batch import PhotoResult


class MainWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QApplication.instance() or QApplication([])

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
                "No photos were cleaned. See the error below the photo list.",
            )

    def test_table_text_has_explicit_normal_selected_and_hover_contrast(self) -> None:
        style = self.window.styleSheet()
        self.assertIn("QTableWidget { color: #171814;", style)
        self.assertIn("QTableWidget::item:selected { color: #171814;", style)
        self.assertIn("QTableWidget::item:hover { color: #171814;", style)


if __name__ == "__main__":
    unittest.main()
