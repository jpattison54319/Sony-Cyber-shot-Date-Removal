from __future__ import annotations

import platform
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw


ASSETS = Path(__file__).resolve().parents[1] / "assets"


def render_icon(size: int) -> Image.Image:
    scale = size / 1024
    image = Image.new("RGBA", (size, size), "#23251f")
    draw = ImageDraw.Draw(image)

    def box(values: tuple[int, int, int, int], radius: int, fill: str) -> None:
        draw.rounded_rectangle(tuple(round(value * scale) for value in values), radius=round(radius * scale), fill=fill)

    box((170, 270, 854, 800), 120, "#f08a24")
    box((290, 190, 540, 330), 55, "#f08a24")
    draw.ellipse(tuple(round(value * scale) for value in (365, 365, 665, 665)), fill="#fffdf7")
    draw.ellipse(tuple(round(value * scale) for value in (445, 445, 585, 585)), fill="#23251f")
    box((710, 330, 790, 390), 24, "#fffdf7")
    return image


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    master = render_icon(1024)
    master.save(ASSETS / "app-icon.png")
    master.save(
        ASSETS / "app-icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    if platform.system() != "Darwin":
        return
    iconset = ASSETS / "DateStampCleaner.iconset"
    iconset.mkdir(exist_ok=True)
    for points in (16, 32, 128, 256, 512):
        render_icon(points).save(iconset / f"icon_{points}x{points}.png")
        render_icon(points * 2).save(iconset / f"icon_{points}x{points}@2x.png")
    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(ASSETS / "app-icon.icns")],
        check=True,
    )


if __name__ == "__main__":
    main()
