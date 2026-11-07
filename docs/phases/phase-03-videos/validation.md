---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-07T05:34:45-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-07T05:33:08-03:00"
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
    status: resolved
    resolved_by: phase-03-videos/TD-03
    confirmation: user-decided
    summary: "TD-03 title defaults to filename sans extension (≤255, may be empty) vs title 1–100"
  - id: AMB-6
    status: resolved
    resolved_by: phase-03-videos/TD-04
    confirmation: user-decided
    summary: "Sweeper queue placement and TD-04 draft-expiry parameters are unspecified"
  - id: AMB-7
    status: resolved
    resolved_by: phase-03-videos/TD-03
    confirmation: user-decided
    summary: "Completion crash window: storage completed but row still draft is unhandled"
  - id: AMB-8
    status: resolved
    resolved_by: phase-03-videos/TD-11
    confirmation: user-decided
    summary: "TD-11/TD-14 stream/download route contract is absent from context.md"
  - id: AMB-9
    status: resolved
    resolved_by: phase-03-videos/TD-03
    confirmation: user-decided
    summary: "No owner-facing read of status/failure_reason/metadata in Phase 03"
  - id: AMB-10
    status: resolved
    resolved_by: phase-03-videos/TD-09
    confirmation: user-decided
    summary: "TD-09: ffprobe/ffmpeg non-zero exit is INVALID_MEDIA but network errors retry"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

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

## Non-blocking Notes

_Re-validation pass 2 (2026-11-07). These are informational. They are not issues, do not affect `status`, and `/plan-build` can settle them when it drafts the SIs._

- **Producer job options.** The worker registers `video-processing` with the TD-12 `defaultJobOptions` (TD-13 revision). The API's own `registerQueue` for `video-processing` must carry the same options too, because jobs added by the API take that Queue's defaults. Without them `job.opts.attempts` is unset, so there are no retries and the TD-12 `failed` handler's `attemptsMade >= opts.attempts` never matches. Suggestion: one shared options constant used by both registrations.
- **Abort/expiry racing with `complete`.** The user abort (TD-03, AMB-7) and the draft expiry (TD-04, AMB-6) both run `DeleteObject` on the original before their guarded `UPDATE … WHERE status = 'draft'`. If a concurrent `complete` wins, the row moves to `processing` and the original is already gone, so the worker ends it as `failed`/`SOURCE_MISSING`. That is still a consistent terminal state. The abort response when its guarded update matches no row is not stated; `409 VIDEO_UPLOAD_NOT_ACTIVE` fits the existing contract.
- **Env names left to the plan.** TD-08's env-configurable worker concurrency has no variable name yet, and the static `@Processor(…, { concurrency: 1 })` option cannot read config, so the plan picks the mechanism (for example, set the worker's concurrency from config at module init). The same goes for the bucket, region, credentials and Redis port variables. Follow the phase-01 conventions: namespaced `registerAs` factories, Joi validation, no `localhost` defaults.
- **Title length unit.** IC-2 counts cuts in Unicode code points. Validating a provided title with class-validator `MaxLength(100)` counts UTF-16 units, which rejects some titles with astral characters (such as emoji) that the column would accept. This only matters at the edge. Using code points for both keeps the rule consistent.

## Resolved Issues

- **IC-1** — Testing Requirements allowed a storage "local adapter" and `localhost` defaults; TD-02/06/07/09/11 need real S3. **User-decided (a):** phase-level testing override. Integration/e2e tests use the real Silo (MinIO) and Redis Compose services via service names (`minio`, `redis`). There is no local-filesystem storage adapter and no `localhost` defaults. Presigned URLs consumed inside containers are signed with the internal endpoint. Recorded as `**Revisions:**` on phase-03-videos/TD-01, TD-06 and TD-07, plus a "Phase 03 testing override" note in context.md `## Testing Requirements`. Fixing `testing-guide-nestjs-project` itself is a separate follow-up. `resolved_by: phase-03-videos/TD-07` (also TD-01, TD-06).
- **AMB-1** — A retained failed job (`jobId = videoId`) made the sweeper re-enqueue a no-op. **Confirmed by user (2026-11-04):** both (a) and (b). (a) The terminal `failed` write lives in the processor's `@OnWorkerEvent('failed')` handler. It fires on `UnrecoverableError` or `attemptsMade >= attempts`, as a guarded UPDATE with `PROCESSING_FAILED` or the domain code. (b) The sweeper, every 15 min, checks `processing` videos older than 30 min (new `processing_started_at`) with `getJob(videoId)` + `getState()`. Missing/unknown → re-add. `failed` → mark video `failed`/`PROCESSING_FAILED` (no re-add). `completed` → remove + re-add. Waiting/active → leave. `resolved_by: phase-03-videos/TD-12` (also TD-13).
- **AMB-2** — The persisted metadata was unspecified. **Confirmed by user (2026-11-04):** at upload start, `original_filename varchar(255)`, `content_type varchar(127)` and `size_bytes bigint`. At ready, `duration_ms integer`, `width integer`, `height integer` and `video_codec varchar(32)`. Not persisted: bitrate, fps, audio, format_name, raw JSON. Invalid media → `INVALID_MEDIA`. `resolved_by: phase-03-videos/TD-09`.
- **AMB-3** — The thumbnail parameters were unspecified. **Confirmed by user (2026-11-04):** frame at `min(1 s, duration/2)` with input seeking. JPEG that fits 1280×720, never upscaled, even dimensions, `-q:v 3`, written to `videos/{videoId}/thumbnail.jpg` (`thumbnail_key`). Retry once at t=0. If there is still no frame, `THUMBNAIL_FAILED` fails the job, so `ready` always has a thumbnail. `resolved_by: phase-03-videos/TD-09`.
- **AMB-4** — "Rascunho" meant upload-pending here vs. unpublished in Phase 04. **User-decided (a):** keep `draft` in `draft → processing → ready | failed` (acceptance-criterion wording). `status` is the processing lifecycle only. Phase 04 adds a separate publication field that gates TD-14. `failure_reason` codes are enumerated. `resolved_by: phase-03-videos/TD-12` (also TD-14).
- **AMB-5** — TD-03 sub-routes and the abort outcome were missing from context.md. **Confirmed by user (2026-11-04):** re-extracted from the decisions body and completed: `POST /videos`, `POST|GET /videos/:id/upload/parts`, `POST /videos/:id/upload/complete`, `DELETE /videos/:id/upload`, with request/response shapes and error codes. A user abort moves the row to `failed` / `UPLOAD_ABORTED` (not deleted). `resolved_by: phase-03-videos/TD-03`.
- **IC-2** — TD-03's title default (filename without extension) could break the 1–100 rule. **User-decided (2026-11-07):** `title varchar(100) NOT NULL`. A provided title is trimmed and must be 1–100. The default is the filename without its last extension, trimmed and cut to 100 code points; if that is empty, the full filename cut to 100. Recorded as a `**Revisions:**` entry on TD-03. `resolved_by: phase-03-videos/TD-03`.
- **AMB-6** — Sweeper queue placement and the TD-04 draft-expiry spec were unspecified. **User-decided (2026-11-07):** the sweeper (`video-sweeper` Job Scheduler) runs on its own `video-maintenance` queue with its own processor and options (`attempts: 1`). The TD-12 `failed` handler ignores jobs without `videoId`. Draft expiry: `VIDEO_UPLOAD_EXPIRE_AFTER_MS` (default 24 h) selects `status='draft' AND created_at < now() - threshold`; per row it runs `AbortMultipartUpload` (`NoSuchUpload` tolerated), `DeleteObject` on the original, and a guarded `failed`/`UPLOAD_EXPIRED` with `upload_id = null`. The three sweeper env vars go in the Joi schema. Recorded as revisions on TD-04 (spec), TD-13 (queue) and TD-12 (guard). `resolved_by: phase-03-videos/TD-04` (also TD-12, TD-13).
- **AMB-7** — The completion crash window (storage completed, row still `draft`) was unhandled. **User-decided (2026-11-07):** on `complete` for a `draft` row, `NoSuchUpload` triggers `HeadObject` on the original. If it exists, the size check, `draft → processing` and enqueue continue. If not, `409 VIDEO_UPLOAD_NOT_ACTIVE` (existing code, no new one) and the sweeper later expires the row. `ListParts` `NoSuchUpload` on a draft also answers `409 VIDEO_UPLOAD_NOT_ACTIVE`, and the user abort now also deletes any original object. Recorded as a revision on TD-03. `resolved_by: phase-03-videos/TD-03`.
- **AMB-8** — The TD-11/TD-14 stream/download contract was missing from context.md. **User-decided (2026-11-07):** `GET /videos/:slug/stream` and `GET /videos/:slug/download`, `@Public()`, `302` to a presigned GET with a **1 h TTL** (library-refs.md corrected from 300 s), `Cache-Control: no-store`. The download uses `ResponseContentDisposition` with the sanitized title plus the original extension (RFC 6266 `filename` + RFC 5987 `filename*`). Unknown slug and non-`ready` video both answer `404 VIDEO_NOT_FOUND`. Recorded as revisions on TD-11 and TD-14. `resolved_by: phase-03-videos/TD-11` (also TD-14).
- **AMB-9** — There was no owner-facing read of status, failure reason or metadata. **User-decided (2026-11-07):** a minimal owner-only `GET /videos/:id` (authenticated; a non-owner gets `404 VIDEO_NOT_FOUND`) returning `{ id, slug, title, status, failureReason, originalFilename, contentType, sizeBytes, durationMs, width, height, videoCodec, createdAt, updatedAt }`, with no thumbnail URL. Listing, editing and deleting stay in Phase 04 (boundary note under context.md `## Capability Coverage`). Recorded as a revision on TD-03. `resolved_by: phase-03-videos/TD-03`.
- **AMB-10** — A non-zero ffprobe/ffmpeg exit was always `INVALID_MEDIA`, even for network errors. **User-decided (2026-11-07):** `HeadObject` the original before ffprobe. `NotFound` → `UnrecoverableError` with the new code `SOURCE_MISSING`; other errors are transient. A non-zero exit whose stderr matches the documented transient list (`Connection refused`, `Connection reset`, `timed out`, `Server returned 5`, `Server returned 403`, `Input/output error`, `I/O error`, `Failed to resolve hostname`) is retried. Otherwise `INVALID_MEDIA` / `THUMBNAIL_FAILED` via `UnrecoverableError`. Recorded as revisions on TD-09 and TD-12 (code list). `resolved_by: phase-03-videos/TD-09` (also TD-12).
