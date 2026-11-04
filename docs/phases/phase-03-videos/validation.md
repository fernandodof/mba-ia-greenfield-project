---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-04T14:14:30-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-26T17:14:37-03:00"
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
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None open (IC-1 resolved — see Resolved Issues)._

### Ambiguities

_None open (AMB-1..AMB-5 resolved — see Resolved Issues)._

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
