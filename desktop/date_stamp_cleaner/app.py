from __future__ import annotations

import sys
import threading
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QObject, Qt, QThread, QUrl, Signal, Slot
from PySide6.QtGui import QColor, QCloseEvent, QDesktopServices, QFont, QIcon, QKeySequence, QPainter, QPixmap, QShortcut
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSizePolicy,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from date_stamp_cleaner.batch import SUPPORTED_EXTENSIONS, prepare_tasks, process_tasks, unique_batch_root
from date_stamp_cleaner.engine import EngineConfigurationError, prepare_engine


APP_NAME = "Date Stamp Cleaner"
MAX_PHOTOS = 500
ROW_DETAIL_ROLE = int(Qt.ItemDataRole.UserRole)
ROW_STATUS_ROLE = ROW_DETAIL_ROLE + 1


def _format_bytes(size: int) -> str:
    if size < 1024 * 1024:
        return f"{max(1, round(size / 1024))} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def _app_icon() -> QIcon:
    pixmap = QPixmap(128, 128)
    pixmap.fill(QColor("#23251f"))
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(QColor("#f08a24"))
    painter.drawRoundedRect(22, 34, 84, 66, 14, 14)
    painter.drawRoundedRect(37, 25, 30, 18, 6, 6)
    painter.setBrush(QColor("#fffdf7"))
    painter.drawEllipse(48, 49, 34, 34)
    painter.setBrush(QColor("#23251f"))
    painter.drawEllipse(57, 58, 16, 16)
    painter.end()
    return QIcon(pixmap)


class PhotoTable(QTableWidget):
    files_dropped = Signal(list)

    def __init__(self) -> None:
        super().__init__(0, 3)
        self.setHorizontalHeaderLabels(["Photo", "Size", "Status"])
        self.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.verticalHeader().setVisible(False)
        self.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.setAlternatingRowColors(True)
        self.setShowGrid(False)
        self.setAcceptDrops(True)
        self.setDragDropMode(QAbstractItemView.DragDropMode.DropOnly)
        self.setAccessibleName("Selected photos and processing status")

    def dragEnterEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        paths = [Path(url.toLocalFile()) for url in event.mimeData().urls() if url.isLocalFile()]
        if any(path.suffix.lower() in SUPPORTED_EXTENSIONS for path in paths):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        event.acceptProposedAction()

    def dropEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        paths = [Path(url.toLocalFile()) for url in event.mimeData().urls() if url.isLocalFile()]
        self.files_dropped.emit(paths)
        event.acceptProposedAction()

    def paintEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        super().paintEvent(event)
        if self.rowCount() != 0:
            return
        painter = QPainter(self.viewport())
        painter.setPen(QColor("#77786f"))
        font = painter.font()
        font.setPointSize(14)
        font.setWeight(QFont.Weight.DemiBold)
        painter.setFont(font)
        painter.drawText(self.viewport().rect().adjusted(24, 0, -24, -10), Qt.AlignmentFlag.AlignCenter, "Drop photos here\nor choose photos")


class ProcessingWorker(QObject):
    status_changed = Signal(int, str, str)
    progress_changed = Signal(int, int)
    completed = Signal(object, str)
    failed = Signal(str)

    def __init__(self, sources: list[Path], output_root: Path) -> None:
        super().__init__()
        self.sources = sources
        self.output_root = output_root
        self._cancel = threading.Event()

    @Slot()
    def run(self) -> None:
        try:
            process_photo = prepare_engine()
            tasks = prepare_tasks(self.sources, self.output_root)
        except (EngineConfigurationError, OSError, ValueError) as error:
            self.failed.emit(str(error))
            return

        completed = 0

        def update(index: int, status: str, detail: str) -> None:
            nonlocal completed
            self.status_changed.emit(index, status, detail)
            if status in {"succeeded", "failed", "canceled"}:
                completed += 1
                self.progress_changed.emit(completed, len(tasks))

        try:
            results, manifest = process_tasks(
                tasks,
                process_photo=process_photo,
                on_status=update,
                should_cancel=self._cancel.is_set,
            )
        except Exception as error:
            self.failed.emit(f"Processing stopped: {str(error).strip() or type(error).__name__}")
            return
        self.completed.emit(results, str(manifest))

    def cancel(self) -> None:
        self._cancel.set()


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.setWindowIcon(_app_icon())
        self.resize(920, 680)
        self.setMinimumSize(760, 560)

        self.sources: list[Path] = []
        self.output_parent = Path.home() / "Pictures"
        self.last_output_root: Path | None = None
        self.worker: ProcessingWorker | None = None
        self.worker_thread: QThread | None = None
        self.close_after_run = False

        central = QWidget()
        central.setObjectName("page")
        self.setCentralWidget(central)
        page = QVBoxLayout(central)
        page.setContentsMargins(34, 28, 34, 28)
        page.setSpacing(18)

        header = QHBoxLayout()
        heading = QVBoxLayout()
        heading.setSpacing(3)
        title = QLabel(APP_NAME)
        title.setObjectName("title")
        subtitle = QLabel("Remove Sony Cyber-shot dates with the validated local workflow.")
        subtitle.setObjectName("subtitle")
        heading.addWidget(title)
        heading.addWidget(subtitle)
        header.addLayout(heading)
        header.addStretch()
        local_badge = QLabel("●  LOCAL ONLY")
        local_badge.setObjectName("localBadge")
        header.addWidget(local_badge)
        page.addLayout(header)

        trust = QFrame()
        trust.setObjectName("trustStrip")
        trust_layout = QHBoxLayout(trust)
        trust_layout.setContentsMargins(18, 11, 18, 11)
        trust_layout.setSpacing(24)
        for text in ("Exact Python workflow", "Originals untouched", "Verified lossless PNG"):
            label = QLabel(f"✓  {text}")
            label.setObjectName("trustItem")
            trust_layout.addWidget(label)
        trust_layout.addStretch()
        page.addWidget(trust)

        card = QFrame()
        card.setObjectName("card")
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(20, 18, 20, 20)
        card_layout.setSpacing(14)

        toolbar = QHBoxLayout()
        self.count_label = QLabel("PHOTOS · 0")
        self.count_label.setObjectName("sectionLabel")
        toolbar.addWidget(self.count_label)
        toolbar.addStretch()
        self.add_button = QPushButton("Choose photos")
        self.add_button.setObjectName("secondaryButton")
        self.add_button.clicked.connect(self.choose_photos)
        self.remove_button = QPushButton("Remove selected")
        self.remove_button.setObjectName("quietButton")
        self.remove_button.clicked.connect(self.remove_selected)
        self.clear_button = QPushButton("Clear")
        self.clear_button.setObjectName("quietButton")
        self.clear_button.clicked.connect(self.clear_photos)
        toolbar.addWidget(self.add_button)
        toolbar.addWidget(self.remove_button)
        toolbar.addWidget(self.clear_button)
        card_layout.addLayout(toolbar)

        self.table = PhotoTable()
        self.table.files_dropped.connect(self.add_photos)
        self.table.itemSelectionChanged.connect(self._refresh_controls)
        self.table.itemSelectionChanged.connect(self._show_selected_detail)
        self.table.cellClicked.connect(self._show_clicked_detail)
        self.table.setMinimumHeight(230)
        card_layout.addWidget(self.table, 1)

        self.detail_panel = QFrame()
        self.detail_panel.setObjectName("detailPanel")
        self.detail_panel.setProperty("kind", "info")
        self.detail_panel.setAccessibleName("Photo processing details")
        detail_layout = QVBoxLayout(self.detail_panel)
        detail_layout.setContentsMargins(14, 11, 14, 12)
        detail_layout.setSpacing(3)
        self.detail_title = QLabel()
        self.detail_title.setObjectName("detailTitle")
        self.detail_body = QLabel()
        self.detail_body.setObjectName("detailBody")
        self.detail_body.setWordWrap(True)
        self.detail_body.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        detail_layout.addWidget(self.detail_title)
        detail_layout.addWidget(self.detail_body)
        self.detail_panel.hide()
        card_layout.addWidget(self.detail_panel)

        destination = QFrame()
        destination.setObjectName("destination")
        destination_layout = QHBoxLayout(destination)
        destination_layout.setContentsMargins(14, 10, 10, 10)
        destination_copy = QVBoxLayout()
        destination_title = QLabel("SAVE RESULTS TO")
        destination_title.setObjectName("smallLabel")
        self.destination_path = QLabel(str(self.output_parent))
        self.destination_path.setObjectName("pathLabel")
        self.destination_path.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        destination_copy.addWidget(destination_title)
        destination_copy.addWidget(self.destination_path)
        destination_layout.addLayout(destination_copy, 1)
        self.destination_button = QPushButton("Change…")
        self.destination_button.setObjectName("quietButton")
        self.destination_button.clicked.connect(self.choose_destination)
        destination_layout.addWidget(self.destination_button)
        card_layout.addWidget(destination)

        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setTextVisible(False)
        self.progress.hide()
        card_layout.addWidget(self.progress)

        actions = QHBoxLayout()
        self.status_label = QLabel("Choose JPG or PNG photos to begin.")
        self.status_label.setObjectName("statusLabel")
        self.status_label.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        actions.addWidget(self.status_label)
        self.open_button = QPushButton("Open results")
        self.open_button.setObjectName("secondaryButton")
        self.open_button.clicked.connect(self.open_results)
        self.open_button.hide()
        actions.addWidget(self.open_button)
        self.stop_button = QPushButton("Stop after current photo")
        self.stop_button.setObjectName("dangerButton")
        self.stop_button.clicked.connect(self.stop_processing)
        self.stop_button.hide()
        actions.addWidget(self.stop_button)
        self.run_button = QPushButton("Remove date stamps")
        self.run_button.setObjectName("primaryButton")
        self.run_button.clicked.connect(self.start_processing)
        actions.addWidget(self.run_button)
        card_layout.addLayout(actions)
        page.addWidget(card, 1)

        footnote = QLabel("Photos never leave this computer. Hidden pixels are reconstructed; pixels outside the timestamp mask are verified unchanged.")
        footnote.setObjectName("footnote")
        footnote.setWordWrap(True)
        page.addWidget(footnote)

        self._apply_style()
        self._refresh_controls()
        QShortcut(QKeySequence.StandardKey.Open, self, activated=self.choose_photos)
        QShortcut(QKeySequence("Ctrl+Return"), self, activated=self.start_processing)
        QShortcut(QKeySequence(Qt.Key.Key_Delete), self, activated=self.remove_selected)

    def _apply_style(self) -> None:
        self.setStyleSheet(
            """
            QWidget#page { background: #f4f1e8; color: #171814; }
            QLabel#title { font-size: 30px; font-weight: 800; letter-spacing: -1px; }
            QLabel#subtitle { color: #67695f; font-size: 14px; }
            QLabel#localBadge { color: #315f4c; background: #e3f0e7; border: 1px solid #cfe2d5; border-radius: 12px; padding: 7px 11px; font-size: 11px; font-weight: 800; }
            QFrame#trustStrip { background: #eeebe1; border: 1px solid #d9d5c8; border-radius: 12px; }
            QLabel#trustItem { color: #3f5f4f; font-size: 12px; font-weight: 650; }
            QFrame#card { background: #fffdf7; border: 1px solid #d9d5c8; border-radius: 18px; }
            QLabel#sectionLabel, QLabel#smallLabel { color: #a94d08; font-size: 10px; font-weight: 800; letter-spacing: 1px; }
            QTableWidget { color: #171814; background: #fbf9f2; alternate-background-color: #f7f4ec; border: 1px dashed #bdb8a9; border-radius: 12px; selection-background-color: #f8e5cf; selection-color: #171814; outline: none; }
            QTableWidget::item { color: #171814; border-bottom: 1px solid #ebe7dd; padding: 9px; }
            QTableWidget::item:selected { color: #171814; background: #f8e5cf; }
            QTableWidget::item:hover { color: #171814; background: #f3eadf; }
            QHeaderView::section { color: #77786f; background: #eeebe1; border: none; border-bottom: 1px solid #d9d5c8; padding: 8px; font-size: 10px; font-weight: 700; }
            QFrame#detailPanel { background: #f8f6ef; border: 1px solid #ded9cc; border-radius: 10px; }
            QFrame#detailPanel[kind="error"] { background: #fff4f0; border-color: #e8c3bd; }
            QFrame#detailPanel[kind="success"] { background: #eef7f1; border-color: #c7dfcf; }
            QLabel#detailTitle { color: #23251f; border: none; font-size: 12px; font-weight: 750; }
            QLabel#detailBody { color: #5d5f56; border: none; font-size: 12px; }
            QFrame#detailPanel[kind="error"] QLabel#detailTitle { color: #92352d; }
            QFrame#detailPanel[kind="success"] QLabel#detailTitle { color: #315f4c; }
            QFrame#destination { background: #f8f6ef; border: 1px solid #e6e1d5; border-radius: 10px; }
            QLabel#pathLabel { color: #4d4f47; font-size: 12px; }
            QLabel#statusLabel { color: #67695f; font-size: 12px; }
            QLabel#footnote { color: #67695f; font-size: 11px; }
            QPushButton { min-height: 38px; padding: 0 14px; border-radius: 9px; font-size: 12px; font-weight: 700; }
            QPushButton#primaryButton { min-height: 44px; color: #fffaf3; background: #23251f; border: 1px solid #23251f; padding: 0 18px; }
            QPushButton#primaryButton:hover { background: #34362f; }
            QPushButton#secondaryButton { color: #23251f; background: #f8f6ef; border: 1px solid #d9d5c8; }
            QPushButton#secondaryButton:hover, QPushButton#quietButton:hover { background: #eeebe1; }
            QPushButton#quietButton { color: #5d5f56; background: transparent; border: 1px solid transparent; padding: 0 10px; }
            QPushButton#dangerButton { color: #a83d32; background: #fff4f0; border: 1px solid #e8c3bd; }
            QPushButton:disabled { color: #9b9c94; background: #ece9e0; border-color: #e1ddd2; }
            QProgressBar { min-height: 7px; max-height: 7px; background: #ebe8df; border: none; border-radius: 3px; }
            QProgressBar::chunk { background: #f08a24; border-radius: 3px; }
            """
        )

    @Slot()
    def choose_photos(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self,
            "Choose photos",
            str(Path.home() / "Pictures"),
            "Photos (*.jpg *.jpeg *.JPG *.JPEG *.png *.PNG)",
        )
        if paths:
            self.add_photos([Path(path) for path in paths])

    @Slot(list)
    def add_photos(self, paths: list[Path]) -> None:
        if self.worker is not None:
            return
        known = {str(path.resolve()).casefold() for path in self.sources}
        rejected = 0
        for path in paths:
            resolved = path.expanduser().resolve()
            key = str(resolved).casefold()
            if (
                len(self.sources) >= MAX_PHOTOS
                or not resolved.is_file()
                or resolved.suffix.lower() not in SUPPORTED_EXTENSIONS
                or key in known
            ):
                rejected += 1
                continue
            known.add(key)
            self.sources.append(resolved)
            row = self.table.rowCount()
            self.table.insertRow(row)
            name_item = QTableWidgetItem(resolved.name)
            name_item.setToolTip(str(resolved))
            self.table.setItem(row, 0, name_item)
            self.table.setItem(row, 1, QTableWidgetItem(_format_bytes(resolved.stat().st_size)))
            status_item = QTableWidgetItem("Ready")
            status_item.setData(ROW_STATUS_ROLE, "ready")
            status_item.setData(ROW_DETAIL_ROLE, "Ready to process.")
            self.table.setItem(row, 2, status_item)
        if rejected:
            self.status_label.setText(f"{rejected} duplicate or unsupported file(s) were skipped.")
        self._refresh_controls()

    @Slot()
    def remove_selected(self) -> None:
        if self.worker is not None:
            return
        rows = sorted({index.row() for index in self.table.selectionModel().selectedRows()}, reverse=True)
        for row in rows:
            self.table.removeRow(row)
            self.sources.pop(row)
        self._hide_detail()
        self._refresh_controls()

    @Slot()
    def clear_photos(self) -> None:
        if self.worker is not None:
            return
        self.sources.clear()
        self.table.setRowCount(0)
        self.last_output_root = None
        self.open_button.hide()
        self.progress.setValue(0)
        self._hide_detail()
        self._refresh_controls()

    @Slot()
    def choose_destination(self) -> None:
        selected = QFileDialog.getExistingDirectory(self, "Choose results folder", str(self.output_parent))
        if selected:
            self.output_parent = Path(selected).resolve()
            self.destination_path.setText(str(self.output_parent))

    @Slot()
    def start_processing(self) -> None:
        if self.worker is not None:
            return
        if not self.sources:
            self.choose_photos()
            return

        output_root = unique_batch_root(self.output_parent, datetime.now())
        self.last_output_root = output_root
        self.progress.setValue(0)
        self.progress.show()
        self.open_button.hide()
        self._hide_detail()
        self.status_label.setText("Checking the included model…")
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 2)
            item.setText("Waiting")
            item.setData(ROW_STATUS_ROLE, "waiting")
            item.setData(ROW_DETAIL_ROLE, "Waiting to process.")

        thread = QThread(self)
        worker = ProcessingWorker(self.sources.copy(), output_root)
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        worker.status_changed.connect(self._set_row_status)
        worker.progress_changed.connect(self._set_progress)
        worker.completed.connect(self._processing_completed)
        worker.failed.connect(self._processing_failed)
        worker.completed.connect(thread.quit)
        worker.failed.connect(thread.quit)
        thread.finished.connect(self._worker_finished)
        self.worker = worker
        self.worker_thread = thread
        self._refresh_controls()
        thread.start()

    @Slot(int, str, str)
    def _set_row_status(self, index: int, status: str, detail: str) -> None:
        if index >= self.table.rowCount():
            return
        label = {
            "processing": "Processing…",
            "succeeded": "Verified",
            "failed": "Failed",
            "canceled": "Canceled",
        }.get(status, status.title())
        item = self.table.item(index, 2)
        item.setText(label)
        item.setData(ROW_STATUS_ROLE, status)
        item.setData(ROW_DETAIL_ROLE, detail)
        item.setToolTip(detail)
        self.status_label.setText(detail)
        if status == "failed":
            name = self.table.item(index, 0).text()
            self._show_detail(f"{name} failed", detail, "error")
        elif self.table.currentRow() == index:
            self._show_selected_detail()

    @Slot(int, int)
    def _set_progress(self, completed: int, total: int) -> None:
        self.progress.setValue(round(completed * 100 / max(1, total)))
        self.status_label.setText(f"{completed} of {total} finished")

    @Slot(object, str)
    def _processing_completed(self, results: object, manifest: str) -> None:
        result_list = list(results) if isinstance(results, list) else []
        succeeded = sum(getattr(result, "status", None) == "succeeded" for result in result_list)
        failed = sum(getattr(result, "status", None) == "failed" for result in result_list)
        canceled = sum(getattr(result, "status", None) == "canceled" for result in result_list)
        failed_results = [result for result in result_list if getattr(result, "status", None) == "failed"]
        failure_messages = {
            str(getattr(result, "error", "")).strip()
            for result in failed_results
            if str(getattr(result, "error", "")).strip()
        }
        if failed and len(failure_messages) == 1:
            noun = "photo" if failed == 1 else "photos"
            self._show_detail(f"{failed} {noun} failed", failure_messages.pop(), "error")
        elif failed:
            self._show_detail(
                f"{failed} photos failed",
                "Select a failed photo to see what happened.",
                "error",
            )
        else:
            self._hide_detail()
        if succeeded:
            self.status_label.setText(f"{succeeded} verified · {failed} failed · {canceled} canceled")
            self.open_button.show()
        elif canceled:
            self.status_label.setText("Processing stopped. No originals were changed.")
        else:
            self.status_label.setText("No photos were cleaned. See the error below the photo list.")
        self.progress.setValue(100 if succeeded + failed + canceled == len(self.sources) else self.progress.value())

    @Slot(str)
    def _processing_failed(self, message: str) -> None:
        self.status_label.setText(message)
        self._show_detail("Processing stopped", message, "error")
        QMessageBox.critical(self, "Date Stamp Cleaner stopped", message)

    @Slot()
    def _worker_finished(self) -> None:
        if self.worker is not None:
            self.worker.deleteLater()
        if self.worker_thread is not None:
            self.worker_thread.deleteLater()
        self.worker = None
        self.worker_thread = None
        self._refresh_controls()
        if self.close_after_run:
            self.close_after_run = False
            self.close()

    @Slot()
    def stop_processing(self) -> None:
        if self.worker is None:
            return
        self.worker.cancel()
        self.stop_button.setEnabled(False)
        self.status_label.setText("Stopping after the current photo…")

    @Slot()
    def open_results(self) -> None:
        if self.last_output_root is None:
            return
        target = self.last_output_root / "images"
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(target)))

    @Slot()
    def _show_selected_detail(self) -> None:
        row = self.table.currentRow()
        if row < 0 or not self.table.selectedItems():
            return
        self._show_row_detail(row)

    @Slot(int, int)
    def _show_clicked_detail(self, row: int, _column: int) -> None:
        self._show_row_detail(row)

    def _show_row_detail(self, row: int) -> None:
        status_item = self.table.item(row, 2)
        name_item = self.table.item(row, 0)
        if status_item is None or name_item is None:
            return
        detail = str(status_item.data(ROW_DETAIL_ROLE) or "").strip()
        status = str(status_item.data(ROW_STATUS_ROLE) or "").strip()
        if not detail:
            return
        kind = "error" if status == "failed" else "success" if status == "succeeded" else "info"
        self._show_detail(f"{name_item.text()} · {status_item.text()}", detail, kind)

    def _show_detail(self, title: str, message: str, kind: str) -> None:
        self.detail_title.setText(title)
        self.detail_body.setText(message)
        self.detail_panel.setAccessibleDescription(f"{title}. {message}")
        if self.detail_panel.property("kind") != kind:
            self.detail_panel.setProperty("kind", kind)
            self.detail_panel.style().unpolish(self.detail_panel)
            self.detail_panel.style().polish(self.detail_panel)
        self.detail_panel.show()

    def _hide_detail(self) -> None:
        self.detail_panel.hide()
        self.detail_title.clear()
        self.detail_body.clear()

    def _refresh_controls(self) -> None:
        running = self.worker is not None
        self.count_label.setText(f"PHOTOS · {len(self.sources)}")
        self.add_button.setEnabled(not running and len(self.sources) < MAX_PHOTOS)
        self.remove_button.setEnabled(not running and bool(self.table.selectedItems()))
        self.clear_button.setEnabled(not running and bool(self.sources))
        self.destination_button.setEnabled(not running)
        self.run_button.setEnabled(not running and bool(self.sources))
        self.run_button.setVisible(not running)
        self.stop_button.setVisible(running)
        self.stop_button.setEnabled(running)
        if not self.sources and not running:
            self.status_label.setText("Choose JPG or PNG photos to begin.")
            self._hide_detail()

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.worker is None:
            event.accept()
            return
        answer = QMessageBox.question(
            self,
            "Processing is active",
            "Stop after the current photo and close?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer == QMessageBox.StandardButton.Yes:
            self.close_after_run = True
            self.stop_processing()
        event.ignore()


def main() -> int:
    application = QApplication(sys.argv)
    application.setApplicationName(APP_NAME)
    application.setOrganizationName("Date Stamp Cleaner")
    application.setWindowIcon(_app_icon())
    window = MainWindow()
    window.show()
    return application.exec()


if __name__ == "__main__":
    raise SystemExit(main())
