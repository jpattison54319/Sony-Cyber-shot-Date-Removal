#!/usr/bin/env python3
"""Deterministic bulk remover for the orange camera timestamp in this archive.

The pipeline has four independently auditable stages:

1. Normalize EXIF orientation and detect the eight orange glyph cores from
   color, geometry, baseline alignment, and date-spacing constraints.
2. Expand the core by a scale-derived radius that covers the dark outline,
   antialiasing, and JPEG ringing.
3. Reconstruct only the local mask, using either auditable classical solvers or
   a fixed local LaMa model for complex mixed backgrounds.
4. Score seam continuity, local texture, and color plausibility; write only
   through the timestamp mask; decode the PNG and verify every outside pixel.

The hidden pixels cannot be recovered as historical ground truth.  What this
program guarantees is deterministic reconstruction and exact preservation of
the canonical, EXIF-oriented RGB array everywhere outside the measured mask.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve
from scipy.spatial import cKDTree


_LAMA_MODEL = None
_LAMA_MODEL_PATH: Path | None = None
_LAMA_MODEL_SHA256: str | None = None
EXPECTED_LAMA_SHA256 = "7ba7aa7ac37a4d41fdbbeba3a2af7ead18058552997e3a3cd1a3b2210c9e6b4c"


LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)

# The 162 accepted golden repairs peak just below 0.30 on highly textured or
# high-contrast scenes.  A 0.35 cutoff retains margin for those legitimate
# structures while still catching a strong, connected glyph-shaped imprint.
TIMESTAMP_IMPRINT_FRACTION_LIMIT = 0.35
TIMESTAMP_IMPRINT_AFFECTED_GLYPH_LIMIT = 3
TIMESTAMP_IMPRINT_COHERENT_FRACTION_LIMIT = 0.35
TIMESTAMP_IMPRINT_COHERENT_GLYPH_LIMIT = 2


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class Component:
    label: int
    area: int
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0 + 1

    @property
    def height(self) -> int:
        return self.y1 - self.y0 + 1

    @property
    def cx(self) -> float:
        return 0.5 * (self.x0 + self.x1)

    @property
    def cy(self) -> float:
        return 0.5 * (self.y0 + self.y1)


def disk(radius: float) -> np.ndarray:
    r = int(math.ceil(radius))
    yy, xx = np.ogrid[-r : r + 1, -r : r + 1]
    return xx * xx + yy * yy <= radius * radius


def bbox(mask: np.ndarray) -> list[int]:
    yy, xx = np.where(mask)
    if len(xx) == 0:
        raise ValueError("empty mask")
    return [int(xx.min()), int(yy.min()), int(xx.max()), int(yy.max())]


def orange_core(rgb: np.ndarray) -> np.ndarray:
    """Conservative orange seed; geometry removes unrelated orange objects."""
    r = rgb[..., 0].astype(np.int16)
    g = rgb[..., 1].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    return (
        (r >= 210)
        & (g >= 55)
        & (g <= 140)
        & (b <= 40)
        & ((r - g) >= 90)
        & ((g - b) >= 35)
    )


def components_from_core(core: np.ndarray) -> tuple[np.ndarray, list[Component]]:
    h, w = core.shape
    search = core.copy()
    search[: int(0.68 * h)] = False
    search[:, : int(0.38 * w)] = False
    labels, count = ndimage.label(search, structure=np.ones((3, 3), dtype=np.uint8))
    objects = ndimage.find_objects(labels)
    minimum_area = max(20, int(round(h * w * 8e-7)))
    result: list[Component] = []
    for label_id, obj in enumerate(objects, start=1):
        if obj is None:
            continue
        ys, xs = obj
        area = int((labels[obj] == label_id).sum())
        component = Component(
            label=label_id,
            area=area,
            x0=int(xs.start),
            y0=int(ys.start),
            x1=int(xs.stop - 1),
            y1=int(ys.stop - 1),
        )
        if area < minimum_area:
            continue
        if not (0.006 * h <= component.height <= 0.065 * h):
            continue
        if component.width > 0.065 * w:
            continue
        result.append(component)
    return labels, result


def sequence_score(seq: list[Component], width: int, height: int) -> float | None:
    if len(seq) != 8:
        return None
    seq = sorted(seq, key=lambda c: c.x0)
    if any(a.x1 >= b.x0 for a, b in zip(seq, seq[1:])):
        return None
    heights = np.array([c.height for c in seq], dtype=np.float64)
    centers_y = np.array([c.cy for c in seq], dtype=np.float64)
    median_h = float(np.median(heights))
    if median_h <= 0:
        return None
    if heights.min() < 0.58 * median_h or heights.max() > 1.42 * median_h:
        return None
    if np.ptp(centers_y) > 0.34 * median_h:
        return None
    span = seq[-1].x1 - seq[0].x0 + 1
    span_ratio = span / median_h
    if not (5.2 <= span_ratio <= 16.5):
        return None
    gaps = np.array([b.x0 - a.x1 - 1 for a, b in zip(seq, seq[1:])])
    if gaps.max() > 2.5 * median_h:
        return None
    if gaps[1] < 0.16 * median_h or gaps[3] < 0.16 * median_h:
        return None
    ordinary = gaps[[0, 2, 4, 5, 6]]
    if gaps[1] < np.median(ordinary) or gaps[3] < np.median(ordinary):
        return None
    bottom = max(c.y1 for c in seq) / height
    right = seq[-1].x1 / width
    if bottom < 0.78 or right < 0.70:
        return None
    height_cv = float(heights.std() / median_h)
    baseline_cv = float(centers_y.std() / median_h)
    spacing_bonus = float((gaps[1] + gaps[3]) / (2.0 * median_h))
    area = sum(c.area for c in seq)
    return (
        7.0 * right
        + 5.0 * bottom
        + 0.25 * math.log1p(area)
        + 0.8 * spacing_bonus
        - 4.0 * height_cv
        - 5.0 * baseline_cv
        - 0.08 * abs(span_ratio - 10.0)
    )


def detect_timestamp(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, dict[str, object]]:
    h, w, _ = rgb.shape
    core_all = orange_core(rgb)
    labels, comps = components_from_core(core_all)
    best: tuple[float, list[Component]] | None = None
    for anchor in comps:
        aligned = [
            c
            for c in comps
            if abs(c.cy - anchor.cy) <= 0.34 * max(c.height, anchor.height)
            and 0.55 <= c.height / anchor.height <= 1.8
        ]
        aligned.sort(key=lambda c: c.x0)
        for start in range(max(0, len(aligned) - 7)):
            seq = aligned[start : start + 8]
            if len(seq) < 8:
                continue
            score = sequence_score(seq, w, h)
            if score is not None and (best is None or score > best[0]):
                best = (score, seq)
    if best is None:
        details = [
            {
                "bbox": [c.x0, c.y0, c.x1, c.y1],
                "area": c.area,
                "height": c.height,
            }
            for c in sorted(comps, key=lambda c: (c.y0, c.x0))
        ]
        raise RuntimeError(f"no eight-glyph timestamp sequence found; candidates={details}")

    score, sequence = best
    selected_labels = np.array([c.label for c in sequence], dtype=np.int32)
    core = np.isin(labels, selected_labels)
    median_height = float(np.median([c.height for c in sequence]))
    radius = float(np.clip(round(0.095 * median_height), 3, 14))
    mask = ndimage.binary_dilation(core, structure=disk(radius))
    stats: dict[str, object] = {
        "detector_score": float(score),
        "glyph_components": 8,
        "glyph_bboxes_inclusive": [
            [c.x0, c.y0, c.x1, c.y1] for c in sorted(sequence, key=lambda c: c.x0)
        ],
        "median_glyph_height": median_height,
        "mask_radius": radius,
        "orange_core_pixels": int(core.sum()),
        "mask_pixels": int(mask.sum()),
        "core_bbox_inclusive": bbox(core),
        "mask_bbox_inclusive": bbox(mask),
    }
    return core, mask, stats


NEIGHBORS = [
    (-1, 0, 1.0),
    (1, 0, 1.0),
    (0, -1, 1.0),
    (0, 1, 1.0),
    (-1, -1, 2.0**-0.5),
    (-1, 1, 2.0**-0.5),
    (1, -1, 2.0**-0.5),
    (1, 1, 2.0**-0.5),
]


def harmonic_fill(rgb: np.ndarray, mask: np.ndarray, guide: np.ndarray | None = None) -> np.ndarray:
    """Solve an isotropic or edge-weighted 8-neighbor Laplace system."""
    h, w, _ = rgb.shape
    yy, xx = np.where(mask)
    n = len(xx)
    index = np.full((h, w), -1, dtype=np.int32)
    index[yy, xx] = np.arange(n, dtype=np.int32)
    source = rgb.astype(np.float64)
    if guide is None:
        guide = source
        sigma_color = None
    else:
        guide = guide.astype(np.float64)
        clean = ~mask
        edge_samples: list[np.ndarray] = []
        for dy, dx, _ in NEIGHBORS[:4]:
            shifted = np.roll(guide, shift=(dy, dx), axis=(0, 1))
            valid = clean & np.roll(clean, shift=(dy, dx), axis=(0, 1))
            edge_samples.append(np.linalg.norm(guide - shifted, axis=2)[valid])
        all_edges = np.concatenate([v for v in edge_samples if len(v)])
        sigma_color = float(np.clip(4.0 * np.median(all_edges), 8.0, 36.0))

    rows: list[int] = []
    cols: list[int] = []
    vals: list[float] = []
    rhs = np.zeros((n, 3), dtype=np.float64)
    for row, (y, x) in enumerate(zip(yy, xx, strict=True)):
        diagonal = 0.0
        for dy, dx, spatial in NEIGHBORS:
            ny, nx = y + dy, x + dx
            if not (0 <= ny < h and 0 <= nx < w):
                continue
            weight = spatial
            if sigma_color is not None:
                difference = float(np.linalg.norm(guide[y, x] - guide[ny, nx]))
                weight *= math.exp(-0.5 * (difference / sigma_color) ** 2)
                weight = max(weight, spatial * 1e-3)
            diagonal += weight
            neighbor_index = index[ny, nx]
            if neighbor_index >= 0:
                rows.append(row)
                cols.append(int(neighbor_index))
                vals.append(-weight)
            else:
                rhs[row] += weight * source[ny, nx]
        rows.append(row)
        cols.append(row)
        vals.append(diagonal)
    matrix = coo_matrix((vals, (rows, cols)), shape=(n, n)).tocsr()
    solved = np.column_stack([spsolve(matrix, rhs[:, c]) for c in range(3)])
    out = source.copy()
    out[yy, xx] = solved
    return out


def directional_fill(rgb: np.ndarray, mask: np.ndarray, radius: int) -> np.ndarray:
    """Front-propagating, direction-weighted local interpolation."""
    source = rgb.astype(np.float64)
    out = source.copy()
    known = ~mask.copy()
    distance = ndimage.distance_transform_edt(mask)
    gy, gx = np.gradient(distance)
    yy, xx = np.where(mask)
    order = np.lexsort((xx, yy, distance[yy, xx]))
    offsets: list[tuple[int, int, float]] = []
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx == 0 and dy == 0:
                continue
            squared = dx * dx + dy * dy
            if squared <= radius * radius:
                offsets.append((dy, dx, math.sqrt(squared)))
    h, w = mask.shape
    for idx in order:
        y, x = int(yy[idx]), int(xx[idx])
        normal = np.array([gy[y, x], gx[y, x]], dtype=np.float64)
        normal_norm = float(np.linalg.norm(normal))
        if normal_norm > 1e-9:
            normal /= normal_norm
        values: list[np.ndarray] = []
        weights: list[float] = []
        for dy, dx, length in offsets:
            ny, nx = y + dy, x + dx
            if not (0 <= ny < h and 0 <= nx < w) or not known[ny, nx]:
                continue
            direction = abs(float(np.dot(np.array([dy, dx]) / length, normal)))
            level = 1.0 / (1.0 + abs(distance[y, x] - distance[ny, nx]))
            weight = (0.05 + direction) * level / (length * length)
            values.append(out[ny, nx])
            weights.append(weight)
        if not values:
            raise RuntimeError("directional fill reached a pixel without known neighbors")
        out[y, x] = np.average(np.stack(values), axis=0, weights=np.array(weights))
        known[y, x] = True
    return out


def nearest_guide(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Extend the closest clean pixel into the narrow mask as an edge guide."""
    _, indices = ndimage.distance_transform_edt(mask, return_indices=True)
    out = rgb.astype(np.float64).copy()
    yy, xx = np.where(mask)
    out[yy, xx] = out[indices[0, yy, xx], indices[1, yy, xx]]
    return out


def bilateral_guide(
    rgb: np.ndarray,
    mask: np.ndarray,
    harmonic: np.ndarray,
    radius: float,
) -> np.ndarray:
    """Joint spatial/color interpolation from clean pixels around the mask.

    The harmonic image supplies a mask-shape-free color estimate.  A KD-tree
    then finds clean nearby pixels that agree in both position and color,
    allowing a dark seam and adjacent skin/floor regions to remain distinct.
    """
    collar_radius = max(18, int(round(radius * 4.0)))
    collar = ndimage.binary_dilation(mask, iterations=collar_radius) & ~mask
    ky, kx = np.where(collar)
    uy, ux = np.where(mask)
    source = rgb.astype(np.float64)
    spatial_sigma = max(8.0, radius * 1.6)
    color_sigma = 18.0
    known_features = np.column_stack(
        [ky / spatial_sigma, kx / spatial_sigma, source[ky, kx] / color_sigma]
    )
    unknown_features = np.column_stack(
        [uy / spatial_sigma, ux / spatial_sigma, harmonic[uy, ux] / color_sigma]
    )
    tree = cKDTree(known_features)
    k = min(12, len(known_features))
    distance, index = tree.query(unknown_features, k=k, workers=-1)
    if k == 1:
        distance = distance[:, None]
        index = index[:, None]
    weights = 1.0 / (distance * distance + 1e-3)
    samples = source[ky[index], kx[index]]
    values = np.sum(samples * weights[..., None], axis=1) / np.sum(weights, axis=1)[:, None]
    out = source.copy()
    out[uy, ux] = values
    return out


def iterative_harmonic(
    rgb: np.ndarray,
    mask: np.ndarray,
    guide: np.ndarray | None = None,
    iterations: int = 140,
) -> np.ndarray:
    """Bounded vectorized Jacobi solve, optionally with bilateral edge weights."""
    source = rgb.astype(np.float64)
    out = nearest_guide(rgb, mask) if guide is None else guide.astype(np.float64).copy()
    if guide is None:
        kernel = np.array(
            [
                [2.0**-0.5, 1.0, 2.0**-0.5],
                [1.0, 0.0, 1.0],
                [2.0**-0.5, 1.0, 2.0**-0.5],
            ],
            dtype=np.float64,
        )
        denominator = float(kernel.sum())
        for iteration in range(iterations):
            previous = out[mask].copy() if iteration % 10 == 0 else None
            averaged = np.stack(
                [ndimage.convolve(out[..., c], kernel, mode="nearest") for c in range(3)],
                axis=2,
            ) / denominator
            out[mask] = averaged[mask]
            if previous is not None and float(np.max(np.abs(out[mask] - previous))) < 0.025:
                break
        return out

    guide = guide.astype(np.float64)
    clean = ~mask
    differences: list[np.ndarray] = []
    for dy, dx, _ in NEIGHBORS[:4]:
        shifted = np.roll(guide, shift=(dy, dx), axis=(0, 1))
        valid = clean & np.roll(clean, shift=(dy, dx), axis=(0, 1))
        differences.append(np.linalg.norm(guide - shifted, axis=2)[valid])
    samples = np.concatenate([value for value in differences if len(value)])
    sigma_color = float(np.clip(4.0 * np.median(samples), 8.0, 36.0))
    edge_weights: list[tuple[int, int, np.ndarray]] = []
    denominator = np.zeros(mask.shape, dtype=np.float64)
    for dy, dx, spatial in NEIGHBORS:
        shifted_guide = np.roll(guide, shift=(dy, dx), axis=(0, 1))
        color_difference = np.linalg.norm(guide - shifted_guide, axis=2)
        weight = spatial * np.exp(-0.5 * (color_difference / sigma_color) ** 2)
        weight = np.maximum(weight, spatial * 1e-3)
        edge_weights.append((dy, dx, weight))
        denominator += weight

    for iteration in range(iterations):
        previous = out[mask].copy() if iteration % 10 == 0 else None
        numerator = np.zeros_like(out)
        for dy, dx, weight in edge_weights:
            numerator += np.roll(out, shift=(dy, dx), axis=(0, 1)) * weight[..., None]
        averaged = numerator / denominator[..., None]
        out[mask] = averaged[mask]
        if previous is not None and float(np.max(np.abs(out[mask] - previous))) < 0.025:
            break
    return out


def continuous_texture_candidate(
    rgb: np.ndarray,
    mask: np.ndarray,
    harmonic: np.ndarray,
    radius: float,
) -> tuple[np.ndarray, list[tuple[int, int]]]:
    """Add robust phase-continuous texture from several translated donors.

    Every donor field spans the entire date region, so texture cannot restart at
    each digit.  We retain only fine high-frequency residuals, robustly clip them,
    and combine several independently translated donors.  Isolated scratches or
    coherent edges therefore do not get copied from a single donor.  Harmonic
    interpolation continues the low-frequency color and illumination.
    """
    base = rgb.astype(np.float64).copy()
    base[mask] = harmonic[mask]
    low_match = ndimage.gaussian_filter(base, sigma=(7.0, 7.0, 0), mode="reflect")
    low_texture = ndimage.gaussian_filter(base, sigma=(1.15, 1.15, 0), mode="reflect")
    residual = base - low_texture
    yy, xx = np.where(mask)
    collar = ndimage.binary_dilation(mask, iterations=max(8, int(round(radius * 2)))) & ~mask
    cy, cx = np.where(collar)
    h, w = mask.shape
    step = max(8, int(round(radius * 2.5)))
    offsets = [
        (dy, dx)
        for distance in (1, 2, 3, 4, 5, 6)
        for dy, dx in (
            (-distance * step, 0),
            (distance * step, 0),
            (0, -distance * step),
            (0, distance * step),
            (-distance * step, -distance * step),
            (-distance * step, distance * step),
            (distance * step, -distance * step),
            (distance * step, distance * step),
        )
    ]
    ranked: list[tuple[float, int, int]] = []
    for dy, dx in offsets:
        donor_y = yy + dy
        donor_x = xx + dx
        if donor_y.min() < 0 or donor_y.max() >= h or donor_x.min() < 0 or donor_x.max() >= w:
            continue
        if mask[donor_y, donor_x].any():
            continue
        sample = np.arange(len(cy))[:: max(1, len(cy) // 8000)]
        sy = cy[sample] + dy
        sx = cx[sample] + dx
        valid = (sy >= 0) & (sy < h) & (sx >= 0) & (sx < w) & ~mask[sy.clip(0, h - 1), sx.clip(0, w - 1)]
        if valid.sum() < max(100, int(0.75 * len(sample))):
            continue
        target = low_match[cy[sample][valid], cx[sample][valid]]
        donor = low_match[sy[valid], sx[valid]]
        score = float(np.mean(np.linalg.norm(target - donor, axis=1)))
        ranked.append((score, dy, dx))
    if not ranked:
        return harmonic.copy(), []

    # Use multiple spatially distinct donors.  A robust median rejects a line,
    # scratch, or JPEG ringing feature that exists at only one translated field.
    ranked.sort()
    selected: list[tuple[int, int]] = []
    minimum_separation = max(step, int(round(radius * 2.0)))
    for _, dy, dx in ranked:
        if all(math.hypot(dy - py, dx - px) >= minimum_separation for py, px in selected):
            selected.append((dy, dx))
        if len(selected) == 5:
            break
    if not selected:
        return harmonic.copy(), []

    donor_stack = np.stack([residual[yy + dy, xx + dx] for dy, dx in selected])
    collar_residual = residual[cy, cx]
    center = np.median(collar_residual, axis=0)
    mad = np.median(np.abs(collar_residual - center), axis=0)
    robust_sigma = np.maximum(1.4826 * mad, 0.75)
    limit = 3.0 * robust_sigma
    donor_stack = np.clip(donor_stack, center - limit, center + limit)
    donor_residual = np.median(donor_stack, axis=0)
    # Median aggregation attenuates stochastic texture; restore a conservative
    # fraction of its expected amplitude without reintroducing donor structures.
    donor_residual *= min(1.55, math.sqrt(len(selected)))
    depth = ndimage.distance_transform_edt(mask)[yy, xx]
    fade = np.clip((depth - 0.5) / max(2.0, radius * 0.55), 0.0, 1.0)
    result = harmonic.copy()
    result[yy, xx] += donor_residual * (0.78 * fade[:, None])
    return result, selected


def local_crop(rgb: np.ndarray, mask: np.ndarray, padding: int) -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    x0, y0, x1, y1 = bbox(mask)
    h, w = mask.shape
    x0 = max(0, x0 - padding)
    y0 = max(0, y0 - padding)
    x1 = min(w - 1, x1 + padding)
    y1 = min(h - 1, y1 + padding)
    return rgb[y0 : y1 + 1, x0 : x1 + 1], mask[y0 : y1 + 1, x0 : x1 + 1], (x0, y0)


def rounded_glyph_rescue_mask(
    mask: np.ndarray,
    glyph_bboxes: list[list[int]],
    radius: float,
) -> np.ndarray:
    """Hide digit-shaped mask boundaries from a second LaMa pass.

    The first inference keeps the original, tightly measured compositor mask.
    If that mask shape is echoed as a dark outline, the rescue inference uses
    rounded boxes around the eight glyphs.  Its generated pixels are still
    copied only through ``mask``, so the outside-mask preservation guarantee is
    unchanged.
    """
    boxes = np.zeros(mask.shape, dtype=bool)
    height, width = mask.shape
    padding = max(2, int(round(radius * 0.35)))
    for x0, y0, x1, y1 in glyph_bboxes:
        left = max(0, int(x0) - padding)
        top = max(0, int(y0) - padding)
        right = min(width - 1, int(x1) + padding)
        bottom = min(height - 1, int(y1) + padding)
        boxes[top : bottom + 1, left : right + 1] = True
    rounding = max(1.0, radius * 0.25)
    rescue = ndimage.binary_dilation(boxes, structure=disk(rounding)) | mask
    if int(rescue.sum()) > int(mask.sum()) * 3:
        raise RuntimeError("rescue inference mask exceeded its safety bound")
    return rescue


def timestamp_imprint_metrics(
    original: np.ndarray,
    candidate: np.ndarray,
    core: np.ndarray,
    mask: np.ndarray,
    glyph_bboxes: list[list[int]],
    radius: float,
) -> dict[str, object]:
    """Measure repeated dark outline carryover at the original glyph edges.

    A scene edge may legitimately be dark.  A camera-date artifact is more
    specific: it follows the dark source outline around several of the eight
    detected glyphs.  This check therefore combines source evidence, local
    candidate contrast, and repetition across glyphs instead of applying a
    global darkness threshold.
    """
    if original.shape != candidate.shape or original.shape[:2] != core.shape:
        raise ValueError("timestamp imprint inputs must share one image shape")
    if mask.shape != core.shape or len(glyph_bboxes) != 8:
        raise ValueError("timestamp imprint check requires the eight-glyph mask")

    x0, y0, x1, y1 = bbox(mask)
    padding = max(12, int(round(radius * 3.0)))
    x0 = max(0, x0 - padding)
    y0 = max(0, y0 - padding)
    x1 = min(original.shape[1] - 1, x1 + padding)
    y1 = min(original.shape[0] - 1, y1 + padding)
    source = original[y0 : y1 + 1, x0 : x1 + 1]
    result = candidate[y0 : y1 + 1, x0 : x1 + 1]
    local_core = core[y0 : y1 + 1, x0 : x1 + 1]
    local_mask = mask[y0 : y1 + 1, x0 : x1 + 1]
    local_boxes = [
        [int(left - x0), int(top - y0), int(right - x0), int(bottom - y0)]
        for left, top, right, bottom in glyph_bboxes
    ]

    source_luma = source.astype(np.float64) @ LUMA
    result_luma = result.astype(np.float64) @ LUMA
    sigma = max(1.5, radius * 0.35)
    source_smooth = ndimage.gaussian_filter(source_luma, sigma=sigma, mode="reflect")
    result_smooth = ndimage.gaussian_filter(result_luma, sigma=sigma, mode="reflect")
    ring = disk(max(2.0, min(radius * 0.58, 7.0)))

    all_outline = np.zeros(local_core.shape, dtype=bool)
    all_residual = np.zeros(local_core.shape, dtype=bool)
    coherent_pixels_total = 0
    per_glyph: list[dict[str, object]] = []
    component_minimum = max(20, int(round(radius * 2.0)))
    for left, top, right, bottom in local_boxes:
        left = max(0, left)
        top = max(0, top)
        right = min(local_core.shape[1] - 1, right)
        bottom = min(local_core.shape[0] - 1, bottom)
        glyph = np.zeros(local_core.shape, dtype=bool)
        glyph[top : bottom + 1, left : right + 1] = local_core[
            top : bottom + 1, left : right + 1
        ]
        zone = ndimage.binary_dilation(glyph, structure=ring) & ~glyph & local_mask
        source_outline = (
            zone
            & ((source_smooth - source_luma) >= 12.0)
            & (source_luma <= 90.0)
        )
        darkness = result_smooth - result_luma
        source_closer_than_local = (
            np.abs(result_luma - source_luma) + 3.0
            < np.abs(result_smooth - source_luma)
        )
        residual = source_outline & (darkness >= 7.0) & source_closer_than_local
        outline_pixels = int(source_outline.sum())
        residual_pixels = int(residual.sum())
        fraction = float(residual_pixels / max(outline_pixels, 1))
        labels, component_count = ndimage.label(
            residual,
            structure=np.ones((3, 3), dtype=np.uint8),
        )
        component_sizes = (
            np.bincount(labels.ravel())[1:]
            if component_count
            else np.array([], dtype=np.int64)
        )
        coherent_pixels = int(component_sizes[component_sizes >= component_minimum].sum())
        coherent_fraction = float(coherent_pixels / max(residual_pixels, 1))
        largest_component = int(component_sizes.max()) if len(component_sizes) else 0
        per_glyph.append(
            {
                "outline_pixels": outline_pixels,
                "residual_pixels": residual_pixels,
                "residual_fraction": fraction,
                "coherent_pixels": coherent_pixels,
                "coherent_fraction": coherent_fraction,
                "largest_component_pixels": largest_component,
            }
        )
        coherent_pixels_total += coherent_pixels
        all_outline |= source_outline
        all_residual |= residual

    outline_pixels = int(all_outline.sum())
    residual_pixels = int(all_residual.sum())
    residual_fraction = float(residual_pixels / max(outline_pixels, 1))
    affected_glyphs = sum(
        int(item["residual_pixels"]) >= 12
        and float(item["residual_fraction"]) >= 0.06
        for item in per_glyph
    )
    coherent_fraction = float(coherent_pixels_total / max(residual_pixels, 1))
    coherent_glyphs = sum(
        int(item["coherent_pixels"]) >= component_minimum
        and float(item["coherent_fraction"]) >= 0.25
        for item in per_glyph
    )
    mean_luma_depth = (
        float(np.mean((result_smooth - result_luma)[all_residual]))
        if all_residual.any()
        else 0.0
    )
    detected = bool(
        residual_fraction >= TIMESTAMP_IMPRINT_FRACTION_LIMIT
        and affected_glyphs >= TIMESTAMP_IMPRINT_AFFECTED_GLYPH_LIMIT
        and coherent_fraction >= TIMESTAMP_IMPRINT_COHERENT_FRACTION_LIMIT
        and coherent_glyphs >= TIMESTAMP_IMPRINT_COHERENT_GLYPH_LIMIT
    )
    return {
        "detected": detected,
        "outline_pixels": outline_pixels,
        "residual_pixels": residual_pixels,
        "residual_fraction": residual_fraction,
        "affected_glyphs": int(affected_glyphs),
        "coherent_pixels": coherent_pixels_total,
        "coherent_fraction": coherent_fraction,
        "coherent_glyphs": int(coherent_glyphs),
        "coherent_component_minimum_pixels": component_minimum,
        "mean_luma_depth": mean_luma_depth,
        "fraction_limit": TIMESTAMP_IMPRINT_FRACTION_LIMIT,
        "affected_glyph_limit": TIMESTAMP_IMPRINT_AFFECTED_GLYPH_LIMIT,
        "coherent_fraction_limit": TIMESTAMP_IMPRINT_COHERENT_FRACTION_LIMIT,
        "coherent_glyph_limit": TIMESTAMP_IMPRINT_COHERENT_GLYPH_LIMIT,
        "per_glyph": per_glyph,
    }


def candidate_metrics(original: np.ndarray, candidate: np.ndarray, mask: np.ndarray) -> dict[str, float]:
    source = original.astype(np.float64)
    test = candidate.astype(np.float64)
    inner = mask & ~ndimage.binary_erosion(mask, structure=np.ones((3, 3)))
    outer = ndimage.binary_dilation(mask, structure=np.ones((3, 3))) & ~mask
    boundary_pairs: list[np.ndarray] = []
    for dy, dx, _ in NEIGHBORS[:4]:
        shifted_mask = np.roll(mask, shift=(dy, dx), axis=(0, 1))
        pairs = mask & ~shifted_mask
        shifted = np.roll(source, shift=(dy, dx), axis=(0, 1))
        boundary_pairs.append(np.linalg.norm(test - shifted, axis=2)[pairs])
    seam = float(np.mean(np.concatenate([v for v in boundary_pairs if len(v)])))

    luma = test @ LUMA
    high = luma - ndimage.gaussian_filter(luma, sigma=2.0, mode="reflect")
    depth = ndimage.distance_transform_edt(mask)
    deep = mask & (depth >= min(3.0, max(1.0, float(depth.max()) * 0.55)))
    if not deep.any():
        deep = mask
    collar = ndimage.binary_dilation(mask, iterations=max(4, int(round(depth.max())))) & ~mask
    texture_inside = float(high[deep].std())
    texture_outside = float(high[collar].std()) if collar.any() else texture_inside
    texture_log_ratio = abs(math.log((texture_inside + 0.5) / (texture_outside + 0.5)))

    grad_y, grad_x = np.gradient(luma)
    grad = np.hypot(grad_y, grad_x)
    grad_inside = float(np.median(grad[deep]))
    grad_outside = float(np.median(grad[collar])) if collar.any() else grad_inside
    gradient_log_ratio = abs(math.log((grad_inside + 0.5) / (grad_outside + 0.5)))

    collar_values = source[collar]
    low = np.percentile(collar_values, 0.5, axis=0)
    high_q = np.percentile(collar_values, 99.5, axis=0)
    values = test[mask]
    outlier = np.maximum(low - values, 0.0) + np.maximum(values - high_q, 0.0)
    outlier_penalty = float(np.mean(outlier))
    score = seam + 8.0 * texture_log_ratio + 4.0 * gradient_log_ratio + 0.5 * outlier_penalty
    return {
        "score": score,
        "seam_rgb_mean": seam,
        "texture_luma_std_inside": texture_inside,
        "texture_luma_std_collar": texture_outside,
        "texture_log_ratio": texture_log_ratio,
        "gradient_log_ratio": gradient_log_ratio,
        "color_outlier_penalty": outlier_penalty,
        "inner_boundary_pixels": int(inner.sum()),
        "outer_boundary_pixels": int(outer.sum()),
    }


def restore(
    rgb: np.ndarray,
    mask: np.ndarray,
    radius: float,
    forced_method: str = "auto",
    core: np.ndarray | None = None,
    glyph_bboxes: list[list[int]] | None = None,
) -> tuple[np.ndarray, dict[str, object]]:
    padding = max(80, int(round(radius * 18)))
    crop, crop_mask, (x0, y0) = local_crop(rgb, mask, padding)
    if forced_method == "lama":
        global _LAMA_MODEL, _LAMA_MODEL_PATH, _LAMA_MODEL_SHA256
        import torch
        from simple_lama_inpainting import SimpleLama

        torch.manual_seed(0)
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        torch.use_deterministic_algorithms(True)
        model_path = Path(os.environ.get("LAMA_MODEL", ""))
        if not model_path.is_file():
            model_path = Path(torch.hub.get_dir()) / "checkpoints" / "big-lama.pt"
        if not model_path.is_file():
            # SimpleLama owns the upstream one-time download path.  Do not run
            # inference until the downloaded bytes pass the pinned digest.
            _LAMA_MODEL = SimpleLama()
            model_path = Path(torch.hub.get_dir()) / "checkpoints" / "big-lama.pt"
        if not model_path.is_file():
            raise RuntimeError("LaMa model file was not found after initialization")
        resolved_model_path = model_path.resolve()
        model_path_changed = _LAMA_MODEL_PATH != resolved_model_path
        if model_path_changed or _LAMA_MODEL_SHA256 is None:
            _LAMA_MODEL_SHA256 = sha256_file(model_path)
        if _LAMA_MODEL_SHA256 != EXPECTED_LAMA_SHA256:
            raise RuntimeError(
                f"unexpected LaMa model SHA-256: {_LAMA_MODEL_SHA256}; "
                f"expected {EXPECTED_LAMA_SHA256}"
            )
        if _LAMA_MODEL is None or model_path_changed:
            os.environ["LAMA_MODEL"] = str(resolved_model_path)
            _LAMA_MODEL = SimpleLama()
        _LAMA_MODEL_PATH = resolved_model_path

        mkldnn_backend = getattr(getattr(torch, "backends", None), "mkldnn", None)
        mkldnn_available = bool(
            mkldnn_backend is not None and mkldnn_backend.is_available()
        )
        mkldnn_primary_enabled = bool(
            mkldnn_backend is not None and mkldnn_backend.enabled
        )

        def run_lama(
            inference_mask: np.ndarray,
            *,
            disable_mkldnn: bool = False,
        ) -> np.ndarray:
            previous_mkldnn = None
            if disable_mkldnn and mkldnn_backend is not None:
                previous_mkldnn = bool(mkldnn_backend.enabled)
                mkldnn_backend.enabled = False
            try:
                generated = np.asarray(
                    _LAMA_MODEL(
                        Image.fromarray(crop, mode="RGB"),
                        Image.fromarray(
                            inference_mask.astype(np.uint8) * 255,
                            mode="L",
                        ),
                    ).convert("RGB")
                )[: crop.shape[0], : crop.shape[1]]
            finally:
                if previous_mkldnn is not None:
                    mkldnn_backend.enabled = previous_mkldnn
            composed = crop.copy()
            composed[crop_mask] = generated[crop_mask]
            return composed

        primary = run_lama(crop_mask)
        metrics = {"lama": candidate_metrics(crop, primary, crop_mask)}
        chosen = primary
        chosen_method = "lama"
        primary_imprint: dict[str, object] | None = None
        native_cpu_imprint: dict[str, object] | None = None
        rescue_imprint: dict[str, object] | None = None
        rescue_mask_pixels: int | None = None
        imprint_check_applied = bool(core is not None and glyph_bboxes is not None)
        if imprint_check_applied:
            assert core is not None and glyph_bboxes is not None
            crop_core = core[y0 : y0 + crop.shape[0], x0 : x0 + crop.shape[1]]
            local_boxes = [
                [
                    int(left - x0),
                    int(top - y0),
                    int(right - x0),
                    int(bottom - y0),
                ]
                for left, top, right, bottom in glyph_bboxes
            ]
            primary_imprint = timestamp_imprint_metrics(
                crop,
                primary,
                crop_core,
                crop_mask,
                local_boxes,
                radius,
            )
            if bool(primary_imprint["detected"]):
                if mkldnn_available and mkldnn_primary_enabled:
                    native_cpu = run_lama(crop_mask, disable_mkldnn=True)
                    metrics["lama_native_cpu"] = candidate_metrics(
                        crop,
                        native_cpu,
                        crop_mask,
                    )
                    native_cpu_imprint = timestamp_imprint_metrics(
                        crop,
                        native_cpu,
                        crop_core,
                        crop_mask,
                        local_boxes,
                        radius,
                    )
                    if not bool(native_cpu_imprint["detected"]):
                        chosen = native_cpu
                        chosen_method = "lama_native_cpu"

                if chosen_method == "lama":
                    rescue_mask = rounded_glyph_rescue_mask(
                        crop_mask,
                        local_boxes,
                        radius,
                    )
                    rescue_mask_pixels = int(rescue_mask.sum())
                    rescue = run_lama(
                        rescue_mask,
                        disable_mkldnn=mkldnn_available and mkldnn_primary_enabled,
                    )
                    metrics["lama_rescue"] = candidate_metrics(crop, rescue, crop_mask)
                    rescue_imprint = timestamp_imprint_metrics(
                        crop,
                        rescue,
                        crop_core,
                        crop_mask,
                        local_boxes,
                        radius,
                    )
                    if bool(rescue_imprint["detected"]):
                        raise RuntimeError(
                            "Reconstruction left a possible dark timestamp outline "
                            "after its rescue pass."
                        )
                    rescue_score = float(metrics["lama_rescue"]["score"])
                    if not math.isfinite(rescue_score):
                        raise RuntimeError(
                            "The outline rescue produced invalid quality metrics."
                        )
                    chosen = rescue
                    chosen_method = "lama_rescue"

        final_imprint = rescue_imprint or native_cpu_imprint or primary_imprint
        final = rgb.copy()
        yy, xx = np.where(crop_mask)
        final[y0 + yy, x0 + xx] = chosen[yy, xx]
        return final, {
            "candidate_metrics": metrics,
            "chosen_method": chosen_method,
            "inpainting_model": "big-lama TorchScript (fixed feed-forward CPU inference)",
            "inpainting_model_sha256": _LAMA_MODEL_SHA256,
            "torch_deterministic_algorithms": True,
            "torch_seed": 0,
            "timestamp_imprint_check_applied": imprint_check_applied,
            "timestamp_imprint_detected": bool(
                final_imprint and final_imprint["detected"]
            ),
            "timestamp_imprint_rescue_used": chosen_method != "lama",
            "timestamp_imprint_primary_metrics": primary_imprint,
            "timestamp_imprint_native_cpu_metrics": native_cpu_imprint,
            "timestamp_imprint_rescue_metrics": rescue_imprint,
            "mkldnn_available": mkldnn_available,
            "mkldnn_primary_enabled": mkldnn_primary_enabled,
            "lama_primary_inference_mask_pixels": int(crop_mask.sum()),
            "lama_rescue_inference_mask_pixels": rescue_mask_pixels,
            "local_crop_bbox_inclusive": [
                x0,
                y0,
                x0 + crop.shape[1] - 1,
                y0 + crop.shape[0] - 1,
            ],
        }
    isotropic = iterative_harmonic(crop, crop_mask)
    edge_guided = iterative_harmonic(crop, crop_mask, guide=isotropic)
    harmonic_texture, texture_offsets = continuous_texture_candidate(
        crop, crop_mask, isotropic, radius
    )
    guide = bilateral_guide(crop, crop_mask, isotropic, radius)
    edge_weighted = iterative_harmonic(crop, crop_mask, guide=guide)
    residual = guide - ndimage.gaussian_filter(guide, sigma=(2.2, 2.2, 0), mode="reflect")
    depth = ndimage.distance_transform_edt(crop_mask)
    fade = np.clip((depth - 0.5) / max(2.0, radius * 0.55), 0.0, 1.0)
    edge_texture = edge_weighted.copy()
    edge_texture[crop_mask] += residual[crop_mask] * (0.55 * fade[crop_mask][:, None])
    candidates = {
        "harmonic": isotropic,
        "harmonic_texture": harmonic_texture,
        "edge_guided": edge_guided,
        "bilateral": guide,
        "edge_weighted": edge_weighted,
        "edge_weighted_texture": edge_texture,
    }
    metrics = {name: candidate_metrics(crop, value, crop_mask) for name, value in candidates.items()}
    chosen_name = (
        min(metrics, key=lambda name: metrics[name]["score"])
        if forced_method == "auto"
        else forced_method
    )
    if chosen_name not in candidates:
        raise ValueError(f"unknown reconstruction method: {chosen_name}")
    chosen = candidates[chosen_name]
    final = rgb.copy()
    yy, xx = np.where(crop_mask)
    final[y0 + yy, x0 + xx] = np.clip(np.rint(chosen[yy, xx]), 0, 255).astype(np.uint8)
    return final, {
        "candidate_metrics": metrics,
        "chosen_method": chosen_name,
        "texture_donor_offsets_yx": [list(offset) for offset in texture_offsets],
        "local_crop_bbox_inclusive": [x0, y0, x0 + crop.shape[1] - 1, y0 + crop.shape[0] - 1],
    }


def process(
    input_path: Path,
    output_path: Path,
    mask_path: Path | None,
    report_path: Path | None,
    method: str = "auto",
) -> dict[str, object]:
    with Image.open(input_path) as opened:
        exif_orientation = int(opened.getexif().get(274, 1))
        canonical_image = ImageOps.exif_transpose(opened).convert("RGB")
    original = np.asarray(canonical_image, dtype=np.uint8)
    core, mask, detection = detect_timestamp(original)
    final, restoration = restore(
        original,
        mask,
        float(detection["mask_radius"]),
        forced_method=method,
        core=core,
        glyph_bboxes=detection["glyph_bboxes_inclusive"],
    )

    final_imprint = timestamp_imprint_metrics(
        original,
        final,
        core,
        mask,
        detection["glyph_bboxes_inclusive"],
        float(detection["mask_radius"]),
    )
    restoration["timestamp_imprint_check_applied"] = True
    restoration["timestamp_imprint_detected"] = bool(final_imprint["detected"])
    restoration["timestamp_imprint_final_metrics"] = final_imprint
    if bool(final_imprint["detected"]):
        raise RuntimeError("Reconstruction left a possible dark timestamp outline.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(final, mode="RGB").save(output_path, format="PNG", compress_level=6, optimize=False)
    if mask_path:
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(mask.astype(np.uint8) * 255, mode="L").save(mask_path, format="PNG")

    with Image.open(output_path) as verification:
        verification.verify()
    with Image.open(output_path) as reopened:
        saved = np.asarray(reopened.convert("RGB"), dtype=np.uint8)
    changed = np.any(saved != original, axis=2)
    outside = changed & ~mask
    remaining = orange_core(saved) & mask
    try:
        detect_timestamp(saved)
        timestamp_redetected = True
    except RuntimeError:
        timestamp_redetected = False
    report: dict[str, object] = {
        "input": str(input_path.resolve()),
        "output": str(output_path.resolve()),
        "canonical_dimensions": [int(original.shape[1]), int(original.shape[0])],
        "input_exif_orientation": exif_orientation,
        "orientation_normalized": bool(exif_orientation not in (0, 1)),
        **detection,
        **restoration,
        "changed_pixels": int(changed.sum()),
        "changed_pixels_outside_mask": int(outside.sum()),
        "remaining_orange_core_pixels_inside_mask": int(remaining.sum()),
        "timestamp_sequence_redetected": timestamp_redetected,
        "outside_mask_rgb_exact": bool(not outside.any()),
        "edited_area_percent": float(mask.sum() * 100.0 / mask.size),
        "input_sha256": sha256_file(input_path),
        "output_sha256": sha256_file(output_path),
        "output_format": "lossless PNG RGB, EXIF orientation normalized",
    }
    if outside.any() or timestamp_redetected or bool(final_imprint["detected"]):
        output_path.unlink(missing_ok=True)
        raise RuntimeError(f"verification failed: {json.dumps(report)}")
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--mask-output", type=Path)
    parser.add_argument("--report-output", type=Path)
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
        default="auto",
    )
    args = parser.parse_args()
    report = process(args.input, args.output, args.mask_output, args.report_output, args.method)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
