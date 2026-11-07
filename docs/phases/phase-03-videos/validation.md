---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 6
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-04T15:35:36-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T15:35:25-03:00"
issues:
  - id: IC-1
    status: resolved
    resolved_by: phase-03-videos/TD-07
    summary: "Testing Requirements allow a storage 'local adapter'; TD-05/06/09/11 need real S3"
  - id: AMB-1
    status: resolved
    resolved_by: phase-03-videos/TD-12
    confirmation: user-confirmed
    summary: "TD-12/TD-13: retained failed job (jobId=videoId) makes sweeper re-enqueue a no-op"
  - id: AMB-2
    status: resolved
    resolved_by: phase-03-videos/TD-09
    confirmation: user-confirmed
    summary: "Which metadata the processing step extracts and persists is unspecified"
  - id: AMB-3
    status: resolved
    resolved_by: phase-03-videos/TD-09
    confirmation: user-confirmed
    summary: "Thumbnail frame choice and output size/format are unspecified"
  - id: AMB-4
    status: resolved
    resolved_by: phase-03-videos/TD-12
    summary: "'rascunho' (draft) means upload-pending here vs. unpublished in Phase 04"
  - id: AMB-5
    status: resolved
    resolved_by: phase-03-videos/TD-03
    confirmation: user-confirmed
    summary: "TD-03 sub-routes and the user-initiated abort outcome are absent from context.md"
  - id: IC-2
    status: open
    summary: "TD-03 title defaults to filename sans extension (≤255, may be empty) vs title 1–100"
  - id: AMB-6
    status: open
    summary: "Sweeper queue placement and TD-04 draft-expiry parameters are unspecified"
  - id: AMB-7
    status: open
    summary: "Completion crash window: storage completed but row still draft is unhandled"
  - id: AMB-8
    status: open
    summary: "TD-11/TD-14 stream/download route contract is absent from context.md"
  - id: AMB-9
    status: open
    summary: "No owner-facing read of status/failure_reason/metadata in Phase 03"
  - id: AMB-10
    status: open
    summary: "TD-09: ffprobe/ffmpeg non-zero exit is INVALID_MEDIA but network errors retry"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-2** — The TD-03 revision (AMB-5) says `POST /videos` takes `title?: string (1–100)` and `filename: string (1–255)`, and that "if `title` is omitted it defaults to `filename` without extension". A filename without its extension can be up to ~251 characters, and it can be empty (e.g. `.mp4`). Either way the stored title breaks the 1–100 rule the same TD sets for `title`. Explicit choice: state the defaulting rule in the TD-03 revision. Recommended: take the filename without its last extension, trim it and cut it to 100 characters. If the result is empty, use the full filename cut to 100 characters. Also state the `title` column type (`varchar(100)`). This is a contract detail, not a user-level decision.

### Ambiguities

- **AMB-6** — The sweeper's queue and the draft-expiry branch are not specified. The TD-13 revision names the scheduler (`upsertJobScheduler('video-sweeper', { every: VIDEO_SWEEPER_INTERVAL_MS })`, 15 min) and fully specifies the `processing` reconciliation. TD-04 only says "Application sweeper … the threshold should be configurable via env (e.g., 24h)". It gives no env name, no default, no scan predicate (`status='draft'` and which timestamp) and no cleanup steps. The TD-12 revision lists `UPLOAD_EXPIRED (TD-04)` with no matching spec. Neither TD says which queue holds the scheduler. If it is `video-processing` (the only queue named), there are two problems. First, sweep jobs wait behind CPU-bound video jobs on the concurrency-1 worker (TD-08). Second, `defaultJobOptions` (`attempts: 3`, `removeOnFail`) and the TD-12 `@OnWorkerEvent('failed')` handler also apply to sweep jobs. That handler runs a guarded UPDATE `WHERE id = job.data.videoId AND status='processing'`, and a sweep job has no `videoId`. TypeORM drops `undefined`/`null` criteria from `where`, so a failed sweep job could mark every `processing` video `failed`. Explicit choice, recorded as a revision on TD-04 (and TD-12/TD-13 if needed). Recommended: (a) a dedicated `video-maintenance` queue with its own processor in the worker app context, so the TD-12 `failed` handler only ever sees `video-processing` jobs. Also have the handler skip any job without `data.videoId`. (b) Draft expiry: `VIDEO_UPLOAD_EXPIRE_AFTER_MS` (default 24 h, the same as the storage-native `stale_uploads_expiry`). Scan for `status='draft' AND created_at < now() - threshold`. Then call `AbortMultipartUpload` (tolerate `NoSuchUpload`), delete any `videos/{id}/original` object, and set a guarded `failed`/`UPLOAD_EXPIRED` with `upload_id = null`. (c) List the env vars in the Joi schema. These are proposed values; the user only needs to confirm them.
- **AMB-7** — The completion crash window is unhandled. TD-13 claims "idempotent completion", but the TD-03 revision only makes a repeated call idempotent on a `processing` row. TD-03's sequence is `CompleteMultipartUpload` → `HeadObject` → size check → `draft → processing` commit. If the process dies or the DB write fails after `CompleteMultipartUpload` succeeds, the row stays `draft` with a stale `upload_id`. A retried `POST …/upload/complete` then gets `NoSuchUpload` from storage, and the context doesn't map that error. Resume (`GET …/upload/parts` → `ListParts`) fails the same way. Later the TD-04 sweeper expires the row as `UPLOAD_EXPIRED` and leaves a complete original object behind. Explicit choice, recorded as a revision on TD-03/TD-13. Recommended: in `complete` for a `draft` row, treat `NoSuchUpload` as "possibly already completed". Run `HeadObject` on `videos/{id}/original`. If the object exists, continue with the size check and the transition. If it is absent, answer `409 VIDEO_UPLOAD_NOT_ACTIVE`, or an explicit new code such as `UPLOAD_SESSION_EXPIRED`. Pair this with AMB-6(b), so expiry deletes any orphaned original. These are proposed values, to be confirmed by the user.
- **AMB-8** — The stream/download contract is not in context.md. This is the same gap AMB-5 fixed for TD-03. TD-11 and TD-14 are Cross-layer and feed `### API Contracts`, but context.md only says "302 redirect to short-lived presigned GET", "public by unique slug" and "`ready` only". It is missing: the route paths and parameter (e.g. `GET /videos/:slug/stream` and `GET /videos/:slug/download`, both `@Public()`), the presigned GET TTL (`library-refs.md` uses 300 s; the TDs only say "short-lived"), and the response for an unknown slug and for a non-`ready` video (e.g. `404 VIDEO_NOT_FOUND` for both, so the lifecycle state isn't revealed). Also missing: the `Content-Disposition` filename source (`original_filename`, RFC 6266 `filename*=UTF-8''…`, per `library-refs.md`) and whether the stream redirect sets `ResponseContentType` from `content_type`. Explicit choice: re-extract these from the TD-11/TD-14 decision bodies into a revision, then fill in the missing values. Recommended values are the examples above. This is mostly mechanical, and the user only needs to confirm the TTL and the non-`ready` status code.
- **AMB-9** — Phase 03 has no read endpoint for the uploader. The context exposes `POST /videos` + upload sub-routes (owner-scoped, TD-03) and public stream/download for `ready` only (TD-14). Nothing lets the owner see `status`, `failure_reason` or the extracted metadata (TD-09 AMB-2 columns). So a client cannot tell when processing has finished or why it failed, and an e2e "upload → ready → stream" flow can only poll the DB. That may be intended (Phase 04 brings "edição das informações do vídeo … painel de administração"), but the boundary is not stated. Explicit choice, which **needs a user decision** (scope boundary with Phase 04): (a) add a minimal owner-scoped `GET /videos/:id` → `200 { id, slug, title, status, failureReason, durationMs, width, height, videoCodec, sizeBytes, createdAt }` (`404 VIDEO_NOT_FOUND` for non-owners) as a TD-03 revision. This is recommended, because it closes the upload loop and makes the acceptance flow testable over HTTP. (b) Defer every read endpoint to Phase 04 and state that explicitly in a TD-14 revision (e2e tests then check status via the repository).
- **AMB-10** — TD-09's failure classification contradicts itself. The AMB-2 revision says "Invalid media → `UnrecoverableError` with reason `INVALID_MEDIA`… ffprobe exiting non-zero or with unparsable JSON". The AMB-3 revision says "Transient errors (storage/network, `execFile` timeout of 120 s…) are thrown normally and retried per TD-12". ffprobe/ffmpeg read the input through an internal presigned GET (TD-09). An unreachable storage service, a 5xx or an expired/invalid signature also makes ffprobe exit non-zero. Under the first rule, a transient storage failure becomes a permanent `INVALID_MEDIA` with no retry. The thumbnail "no frame" fallback (`THUMBNAIL_FAILED`) has the same problem. Explicit choice, recorded as a TD-09 revision. Recommended: (a) run `HeadObject` on the original with the internal client before ffprobe. Errors there are transient and thrown normally. (b) Classify a non-zero ffprobe/ffmpeg exit as transient when stderr shows an I/O or HTTP failure (`Server returned`, `Connection refused`, `I/O error`, `timed out`). Otherwise it is `INVALID_MEDIA`/`THUMBNAIL_FAILED`. These are proposed values, to be confirmed by the user.

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **IC-1** — Testing Requirements allowed a storage "local adapter" and `localhost` defaults; TD-02/06/07/09/11 need real S3. **User-decided (a):** phase-level testing override. Integration/e2e tests use the real Silo (MinIO) and Redis Compose services via service names (`minio`, `redis`). There is no local-filesystem storage adapter and no `localhost` defaults. Presigned URLs consumed inside containers are signed with the internal endpoint. Recorded as `**Revisions:**` on phase-03-videos/TD-01, TD-06 and TD-07, plus a "Phase 03 testing override" note in context.md `## Testing Requirements`. Fixing `testing-guide-nestjs-project` itself is a separate follow-up. `resolved_by: phase-03-videos/TD-07` (also TD-01, TD-06).
- **AMB-1** — A retained failed job (`jobId = videoId`) made the sweeper re-enqueue a no-op. **Confirmed by user (2026-11-04):** both (a) and (b). (a) The terminal `failed` write lives in the processor's `@OnWorkerEvent('failed')` handler. It fires on `UnrecoverableError` or `attemptsMade >= attempts`, as a guarded UPDATE with `PROCESSING_FAILED` or the domain code. (b) The sweeper, every 15 min, checks `processing` videos older than 30 min (new `processing_started_at`) with `getJob(videoId)` + `getState()`. Missing/unknown → re-add. `failed` → mark video `failed`/`PROCESSING_FAILED` (no re-add). `completed` → remove + re-add. Waiting/active → leave. `resolved_by: phase-03-videos/TD-12` (also TD-13).
- **AMB-2** — The persisted metadata was unspecified. **Confirmed by user (2026-11-04):** at upload start, `original_filename varchar(255)`, `content_type varchar(127)` and `size_bytes bigint`. At ready, `duration_ms integer`, `width integer`, `height integer` and `video_codec varchar(32)`. Not persisted: bitrate, fps, audio, format_name, raw JSON. Invalid media → `INVALID_MEDIA`. `resolved_by: phase-03-videos/TD-09`.
- **AMB-3** — The thumbnail parameters were unspecified. **Confirmed by user (2026-11-04):** frame at `min(1 s, duration/2)` with input seeking. JPEG that fits 1280×720, never upscaled, even dimensions, `-q:v 3`, written to `videos/{videoId}/thumbnail.jpg` (`thumbnail_key`). Retry once at t=0. If there is still no frame, `THUMBNAIL_FAILED` fails the job, so `ready` always has a thumbnail. `resolved_by: phase-03-videos/TD-09`.
- **AMB-4** — "Rascunho" meant upload-pending here vs. unpublished in Phase 04. **User-decided (a):** keep `draft` in `draft → processing → ready | failed` (acceptance-criterion wording). `status` is the processing lifecycle only. Phase 04 adds a separate publication field that gates TD-14. `failure_reason` codes are enumerated. `resolved_by: phase-03-videos/TD-12` (also TD-14).
- **AMB-5** — TD-03 sub-routes and the abort outcome were missing from context.md. **Confirmed by user (2026-11-04):** re-extracted from the decisions body and completed: `POST /videos`, `POST|GET /videos/:id/upload/parts`, `POST /videos/:id/upload/complete`, `DELETE /videos/:id/upload`, with request/response shapes and error codes. A user abort moves the row to `failed` / `UPLOAD_ABORTED` (not deleted). `resolved_by: phase-03-videos/TD-03`.
