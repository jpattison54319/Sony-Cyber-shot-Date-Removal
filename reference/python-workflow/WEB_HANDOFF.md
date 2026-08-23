# Web-service handoff

## Recommended service shape

Use an asynchronous job API rather than holding an HTTP request open:

1. upload source to private object storage;
2. validate MIME type, decoded dimensions, pixel count, and file size;
3. enqueue an immutable job containing source hash and detector profile;
4. run preflight detection;
5. process in an isolated CPU worker with the verified model mounted read-only;
6. run per-file and batch audits;
7. store output PNG, mask PNG, and report JSON together;
8. issue a short-lived download URL;
9. expire source and results according to a published retention policy.

## Suggested endpoints

```text
POST /v1/jobs                 create a job
GET  /v1/jobs/{id}            status and audit summary
GET  /v1/jobs/{id}/output     authorized result download
GET  /v1/jobs/{id}/mask       exact edit boundary
GET  /v1/jobs/{id}/report     machine-readable provenance
DELETE /v1/jobs/{id}          delete retained artifacts
```

For multi-photo jobs, expose a manifest and a ZIP assembled only after every
member reaches `passed`, `review_required`, or `rejected`.

## Required safety controls

- Decode with bounded resources; reject decompression bombs and pathological
  dimensions.
- Never trust user filenames or archive paths.
- Scan ZIP inputs and block symlinks and path traversal.
- Strip application credentials from worker environments.
- Disable outbound network after the model is staged.
- Enforce time, memory, disk, and concurrency limits.
- Encrypt stored photos and use private buckets.
- Publish deletion and retention behavior.
- Do not train on uploads without explicit consent.
- Preserve the original privately until the job audit completes.
- Never overwrite the user’s original by default.

## Product language

Accurately say:

> Pixels outside the detected timestamp mask are preserved exactly in decoded
> RGB space. Pixels hidden by the timestamp are reconstructed and cannot be
> guaranteed to match the original scene.

Do not market the result as recovering the true hidden pixels.

## Scaling notes

- Model load dominates cold start; keep a bounded pool of warm CPU workers.
- PNG encoding and object-storage transfer may dominate inference time.
- Use one model instance per process; avoid reloading for every image.
- Batch review sheets should be generated asynchronously.
- Record detector version, code revision, model digest, dependency lock, and
  container digest with every output.

