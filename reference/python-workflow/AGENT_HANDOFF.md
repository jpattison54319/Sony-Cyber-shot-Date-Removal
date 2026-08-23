# Agent handoff brief

## Objective

Turn this verified CLI workflow into a privacy-conscious asynchronous website
without weakening its core invariants.

## Preserve these invariants

1. Detector failure produces no edited output.
2. The accepted image starts as an exact canonical source copy.
3. Model output is assigned only through the saved binary mask.
4. Output stays lossless PNG.
5. Every output is structurally reopened and decoded.
6. Outside-mask RGB differences must equal zero.
7. The timestamp detector must not redetect an eight-glyph sequence.
8. A strong connected timestamp imprint must trigger rescue or fail closed.
9. Source, output, code, detector-profile, dependency, and model hashes remain
   associated with the job.

## Suggested implementation order

1. Wrap `process()` in a background worker without changing it.
2. Add object storage and a small job database.
3. Build upload, status, result, mask, report, and delete endpoints.
4. Add authentication, quotas, retention, and abuse controls.
5. Add a browser UI showing the exact mask and audit result.
6. Add explicit detector profiles rather than a broad automatic text remover.
7. Containerize with a pre-staged, hash-verified model.
8. Load-test PNG encoding, storage transfer, cancellation, and cleanup.

## Important product limitation

The timestamp hides original scene pixels. The website must describe those
pixels as reconstructed, never recovered. The literal exactness guarantee
applies only outside the recorded mask in canonical decoded RGB space.

## Known production work

- Add integration fixtures that the project has redistribution rights to ship.
- Decide whether uploads may contain people and document privacy handling.
- Review all dependency and model licenses before public/commercial deployment.
- Pin a container digest and test reproducibility on the deployment CPU.
- Add detector profiles for other timestamp colors, fonts, layouts, and corners.
- Add a manual-review state for low-confidence or edge-heavy reconstructions.
