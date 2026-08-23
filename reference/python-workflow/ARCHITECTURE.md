# Architecture and invariants

## 1. Canonical image space

`Pillow.ImageOps.exif_transpose` applies the JPEG orientation tag, after which
the image is converted to RGB. All masks, reports, comparisons, and output
coordinates refer to this upright canonical array.

Raw JPEG byte equality is neither promised nor useful: JPEG is compressed and
the output is PNG. The exact invariant is decoded canonical RGB equality outside
the mask.

## 2. Detector profile

The orange core predicate is:

```text
R >= 210
55 <= G <= 140
B <= 40
R - G >= 90
G - B >= 35
```

Only the lower 32% and rightmost 62% of the image are searched. Connected
components are filtered by image-relative area, height, and width. A valid date
must contain eight non-overlapping components with:

- consistent glyph heights;
- a common vertical center/baseline;
- a plausible total span relative to glyph height;
- two larger field gaps after component 2 and component 4;
- bottom placement at or below 78% of image height;
- final glyph at or beyond 70% of image width.

These constraints distinguish the overlay from orange clothing, signs, skin,
or scenery. If no valid sequence exists, processing fails without writing an
output.

## 3. Mask

The selected glyph cores are dilated with a circular structuring element. Radius
is `round(0.095 * median_glyph_height)`, clamped to `[3, 14]`. This empirically
covers the orange fill, dark outline, antialiasing, and nearby JPEG ringing for
the profiled camera.

The mask is saved as an 8-bit PNG and its inclusive bounding box, area, radius,
and glyph boxes are recorded in JSON.

## 4. Reconstruction backend

The production method is `lama`:

- fixed `big-lama.pt` TorchScript model;
- expected SHA-256
  `7ba7aa7ac37a4d41fdbbeba3a2af7ead18058552997e3a3cd1a3b2210c9e6b4c`;
- CPU inference;
- Torch seed 0;
- `torch.use_deterministic_algorithms(True)`;
- local crop only.

Classical harmonic, edge-guided, bilateral, and texture candidates remain in
the code for diagnostics. They are deterministic but are not recommended as
the general default for dates crossing people, fabric, text, and textured
backgrounds.

## 5. Hard compositor

The final array starts as `original.copy()`. Generated values are assigned only
at `mask == True`. There is no alpha blend, resize, enhancement, color grading,
or whole-image model output in the acceptance path.

## 6. Verification

Before success is reported:

1. save PNG;
2. run Pillow structural `verify()`;
3. reopen and fully decode RGB;
4. compare against canonical source;
5. require zero changed pixels outside the mask;
6. rerun the timestamp detector and require no date sequence;
7. record source/output SHA-256 values.

`audit_timestamp_batch.py` checks every report and every PNG container again.
The review-sheet step is a separate visual gate for artifacts that numeric
tests cannot define.

## 7. Determinism boundary

The same source bytes, EXIF metadata, code, dependency versions, model hash,
CPU backend, and worker settings are intended to produce the same canonical
output. A production service should record all of those values with each job.

Different hardware kernels or dependency versions can affect neural inference.
If cross-host byte-identical masked pixels are legally or scientifically
required, validate that property on the exact deployment image and retain its
container digest. The outside-mask equality invariant does not depend on model
determinism.

## 8. Extending to other timestamps

Do not turn the current detector into a broad “orange-ish text” remover. Add a
new explicit profile containing:

- color-space bounds;
- location bounds;
- component count and geometry;
- expected field spacing;
- scale-to-mask rule;
- validation fixtures.

Select a profile only when it scores confidently. Otherwise return a review
state and do not edit.

