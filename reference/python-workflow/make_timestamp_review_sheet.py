#!/usr/bin/env python3
"""Create a deterministic before/after crop sheet from a batch manifest."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def fit_width(image: Image.Image, width: int) -> Image.Image:
    height = max(1, round(image.height * width / image.width))
    return image.resize((width, height), Image.Resampling.LANCZOS)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--columns", type=int, default=2)
    parser.add_argument("--cell-width", type=int, default=720)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text())
    successful = [item for item in manifest["results"] if item["status"] == "succeeded"]
    stop = None if args.limit is None else args.start + args.limit
    successful = successful[args.start:stop]
    cells: list[Image.Image] = []
    font = ImageFont.load_default()
    for item in successful:
        report = json.loads(Path(item["report"]).read_text())
        x0, y0, x1, y1 = report["mask_bbox_inclusive"]
        pad_x = max(30, round((x1 - x0 + 1) * 0.08))
        pad_y = max(24, round((y1 - y0 + 1) * 0.55))
        with Image.open(item["input"]) as opened:
            before = ImageOps.exif_transpose(opened).convert("RGB")
        after = Image.open(item["output"]).convert("RGB")
        box = (
            max(0, x0 - pad_x),
            max(0, y0 - pad_y),
            min(before.width, x1 + pad_x + 1),
            min(before.height, y1 + pad_y + 1),
        )
        before_crop = fit_width(before.crop(box), args.cell_width)
        after_crop = fit_width(after.crop(box), args.cell_width)
        label_height = 28
        cell = Image.new(
            "RGB",
            (args.cell_width, label_height + before_crop.height + after_crop.height + 4),
            (30, 30, 30),
        )
        draw = ImageDraw.Draw(cell)
        draw.text((8, 7), Path(item["input"]).stem, fill=(240, 240, 240), font=font)
        cell.paste(before_crop, (0, label_height))
        cell.paste(after_crop, (0, label_height + before_crop.height + 4))
        cells.append(cell)

    columns = max(1, args.columns)
    rows = (len(cells) + columns - 1) // columns
    row_heights = [0] * rows
    for index, cell in enumerate(cells):
        row_heights[index // columns] = max(row_heights[index // columns], cell.height)
    sheet = Image.new(
        "RGB",
        (columns * args.cell_width + (columns - 1) * 8, sum(row_heights) + (rows - 1) * 8),
        (20, 20, 20),
    )
    y_positions = []
    running = 0
    for height in row_heights:
        y_positions.append(running)
        running += height + 8
    for index, cell in enumerate(cells):
        row, column = divmod(index, columns)
        sheet.paste(cell, (column * (args.cell_width + 8), y_positions[row]))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.output, format="PNG", compress_level=6)


if __name__ == "__main__":
    main()
