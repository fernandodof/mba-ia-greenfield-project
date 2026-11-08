---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-21T14:17:11-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-07T05:33:08-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-21T14:17:11-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-21T14:17:11-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-21T14:17:11-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-21T14:17:11-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-21T14:17:11-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-07T05:34:45-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in `docs/project-plan.md`._ The video UI in `next-frontend/` is not part of this phase (see Deferred subprojects).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` — videos module, video worker (same codebase, separate process/container), `videos` table migration and the new Compose infrastructure (object storage, queue, worker). _(The project-plan phase section names no subproject; taken from `_Subprojects in scope:_` in `docs/decisions/technical-decisions-phase-03-videos.md`.)_

**Deferred subprojects:** `next-frontend/` — Phase 03 is backend-only; the video UI is not part of this phase. Cross-layer TDs (TD-02, TD-03, TD-06, TD-10, TD-11, TD-14) define the HTTP/storage contract a future frontend will consume through its BFF.

**Sequencing notes:** Depende de: Fase 01, Fase 02. "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03) — edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Queue Technology for Video Processing Jobs | decided | A (BullMQ on Redis via `@nestjs/bullmq`) | `@nestjs/bullmq@^12.0.0`, `bullmq@^6.6.1`, `ioredis@^5.11.1`, `redis:8.10.3-alpine` (Docker image) |
|     └─ Last revision: 2026-11-04 — Testing override (IC-1, user-decided): real Redis via Compose service name… | | | | | | |
| phase-03-videos/TD-02 | phase | Cross-layer | Upload Protocol for Files up to 10GB | decided | A (S3 multipart with presigned part URLs, direct to storage) | `@aws-sdk/client-s3@^3.1161.0`, `@aws-sdk/s3-request-presigner@^3.1161.0` |
|     └─ Last revision: 2026-11-04 — _(library-pinning note, confirmed)_ S3 clients use `WHEN_REQUIRED` checksums… | | | | | | |
| phase-03-videos/TD-03 | phase | Cross-layer | Upload Session API Shape and Draft Pre-registration | decided | A (single start call creates draft + multipart session) | — |
|     └─ Last revision: 2026-11-07 — Title default/`varchar(100)` (IC-2), completion `NoSuchUpload` recovery (AMB-7), owner `GET /videos/:id` (AMB-9); user-decided… | | | | | | |
| phase-03-videos/TD-04 | phase | Backend | Abandoned / Incomplete Upload Cleanup | decided | B (app sweeper job + storage-native expiry) | — |
|     └─ Last revision: 2026-11-07 — Draft expiry spec + dedicated `video-maintenance` queue (AMB-6, user-decided)… | | | | | | |
| phase-03-videos/TD-05 | phase | Backend | Object Storage Layout (Buckets and Keys) | decided | A (single private bucket, `videos/{videoId}/…`) | — |
| phase-03-videos/TD-06 | phase | Cross-layer | Presigned URL Endpoint — Internal vs. Public Host | decided | A (internal endpoint for operations, public endpoint for signing) | `@aws-sdk/client-s3@^3.1161.0`, `@aws-sdk/s3-request-presigner@^3.1161.0` |
|     └─ Last revision: 2026-11-04 — Testing override (IC-1, user-decided): in-container presign with internal endpoint… | | | | | | |
| phase-03-videos/TD-07 | phase | Repo-wide | MinIO Image Source for Local Docker Compose | decided | A (`pgsty/silo`, pinned release tag) | `pgsty/silo:RELEASE.2026-10-26T00-00-00Z`, `pgsty/mc:RELEASE.2026-10-26T00-00-00Z` (Docker images) |
|     └─ Last revision: 2026-11-04 — Testing override (IC-1, user-decided): real Silo, no local-FS adapter; pin bumped… | | | | | | |
| phase-03-videos/TD-08 | phase | Repo-wide | Video Worker Runtime Topology | decided | A (same codebase, separate entrypoint + `video-worker` service) | — |
| phase-03-videos/TD-09 | phase | Backend | FFmpeg Integration — Installation, Invocation and Media Access | decided | A (apt ffmpeg + `execFile` wrapper + presigned GET input) | `ffmpeg` / `ffprobe` 5.1.x (Debian 12 bookworm apt, `7:5.1.9-0+deb12u1`) |
|     └─ Last revision: 2026-11-07 — `HeadObject` pre-check (`SOURCE_MISSING`) + transient stderr classification (AMB-10, user-decided)… | | | | | | |
| phase-03-videos/TD-10 | phase | Cross-layer | Unique Video URL Identifier | decided | A (random 11-char base64url + unique constraint + retry) | — |
| phase-03-videos/TD-11 | phase | Cross-layer | Streaming and Download Delivery | decided | A (302 to short-lived presigned GET; `ResponseContentDisposition` for download) | `@aws-sdk/s3-request-presigner@^3.1161.0` |
|     └─ Last revision: 2026-11-07 — Stream/download contract: routes, 302 TTL 1 h, filename, 404 for non-`ready` (AMB-8, user-decided)… | | | | | | |
| phase-03-videos/TD-12 | phase | Backend | Video Status Lifecycle and Processing Failure Handling | decided | A (`draft → processing → ready \| failed`, 3 attempts + backoff, terminal failed) | — |
|     └─ Last revision: 2026-11-07 — Failed-handler `videoId` guard (AMB-6); `SOURCE_MISSING` code added (AMB-10); user-decided… | | | | | | |
| phase-03-videos/TD-13 | phase | Backend | Consistency Between Upload Completion and Job Enqueue | decided | A (commit then enqueue with `jobId = videoId`, idempotent completion, sweeper) | — |
|     └─ Last revision: 2026-11-07 — Sweeper scheduler moved to the `video-maintenance` queue (AMB-6, user-decided)… | | | | | | |
| phase-03-videos/TD-14 | phase | Cross-layer | Access Policy for Streaming and Download in Phase 03 | decided | A (public by unique slug, `ready` only) | — |
|     └─ Last revision: 2026-11-07 — Non-`ready` → `404 VIDEO_NOT_FOUND` (AMB-8, user-decided)… | | | | | | |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-05, phase-03-videos/TD-07 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-08 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-04, phase-03-videos/TD-06 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-12 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-12, phase-03-videos/TD-13 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-12 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06, phase-03-videos/TD-11, phase-03-videos/TD-14 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06, phase-03-videos/TD-11, phase-03-videos/TD-14 |

_Boundary note (validation AMB-9, user-decided 2026-11-07):_ the owner-only `GET /videos/:id` (TD-03 revision) is a supporting read on the `videos` resource. It lets the uploader follow the processing lifecycle (TD-12) over HTTP and adds no capability of its own, so the coverage above is unchanged. Listing the channel's videos, editing title/metadata and deleting videos stay in Phase 04 (video management and the channel admin panel).

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ on Redis via `@nestjs/bullmq` — it is the official Nest path already prescribed by the project's best-practices skill, offers per-video `jobId` dedupe, retries/backoff and Job Schedulers out of the box, and makes the queue a real, separate Compose service as the architecture and acceptance criteria expect; the cost is one Redis container plus the dual-write handling in TD-13. pg-boss (B) is the strongest alternative if avoiding new infrastructure matters more than official Nest integration. Exact `bullmq` major (5.x vs 6.x) is a library-pinning concern for `plan-resolve`.

**Libraries:** `@nestjs/bullmq@^12.0.0`, `bullmq@^6.6.1`, `ioredis@^5.11.1`, `redis:8.10.3-alpine` (Docker image)

**Revisions:**

- 2026-11-04 — Testing override (IC-1, user-decided): queue producers, the video processor and the sweeper scheduler are integration/e2e-tested against the real Redis Compose service, addressed by its Compose service name (`REDIS_HOST=redis`). There is no in-memory queue fake and no `localhost` default in config factories, Joi defaults or test helpers. Redis runs with `maxmemory-policy noeviction`; worker connections keep ioredis `maxRetriesPerRequest: null` (BullMQ default for workers). `ioredis` is pinned to the 5.x line BullMQ 6 is tested against (`bullmq` devDependency `ioredis@5.11.1`), not the new 6.0.0 major. Rationale: the `testing-guide-nestjs-project` connection example (`REDIS_HOST ?? 'localhost'`) contradicts the root CLAUDE.md Docker-networking rule and the exercise's "não mocke o que dá para testar com a infra do Compose"; updating the guide itself is a separate follow-up.

### phase-03-videos/TD-02

**Recommendation:** S3 multipart with presigned part URLs — the only option that both keeps bytes off the API and supports 10GB on production S3, with resumability via `ListParts`. Suggested parameters for the plan: max declared size 10 GiB (10 × 1024³ bytes), fixed part size 64 MiB (≤ 160 parts for 10 GiB, well under 10,000), presigned URL TTL ~1h, size verified again with `HeadObject` before accepting completion. API shape and draft creation are in TD-03; cleanup in TD-04.

**Libraries:** `@aws-sdk/client-s3@^3.1161.0`, `@aws-sdk/s3-request-presigner@^3.1161.0`

**Revisions:**

- 2026-11-04 — _(library-pinning note from plan-resolve — confirmed by user 2026-11-04)_ Both `S3Client` instances (internal and public, TD-06) set `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'`, plus `forcePathStyle: true`. Rationale: since the SDK's default data-integrity protections (`WHEN_SUPPORTED`), `UploadPart`/`PutObject` get a default CRC32 checksum algorithm; presigned part URLs would then require checksum headers the client cannot compute per part, and S3-compatible servers may reject them (confirmed via Context7 `/aws/aws-sdk-js-v3`, flexible-checksums middleware).

### phase-03-videos/TD-03

**Recommendation:** Single start call creates draft + multipart session — matches the capability literally, keeps one resource and one table, and the extra `upload_id` column is cheap; Option B's flexibility (re-upload) is not required by any Phase 03 bullet. Endpoints are authenticated (global JWT guard) and the draft belongs to the caller's channel.

**Libraries:** —

**Revisions:**

- 2026-11-04 — _(proposed by plan-resolve — confirmed by user 2026-11-04)_ Upload-session contract carried into the plan (AMB-5). Re-extracted from Option A's body and completed. All routes are authenticated (global JWT guard). They are owner-scoped: a video not owned by the caller's channel answers `404 VIDEO_NOT_FOUND`, the same as a missing one. Errors use the `{ statusCode, error, message }` envelope (phase-02-auth/TD-07). (1) `POST /videos` takes `{ title?: string (1–100), filename: string (1–255), size: integer 1..10 GiB, contentType: string matching ^video/ }`. It returns `201 { id, slug, status: 'draft', partSize, partCount }`, with `partSize` = 64 MiB and `partCount = ceil(size / partSize)`. The S3 `uploadId` stays server-side on the row and is not exposed (refines the Option A sketch). If `title` is omitted it defaults to `filename` without extension. (2) `POST /videos/:id/upload/parts` takes `{ partNumbers: integer[] }` (unique, each 1..partCount, 1..partCount entries). It returns `200 { parts: [{ partNumber, url }], expiresAt }` (presigned `UploadPart`, TTL 1h, public endpoint). (3) `GET /videos/:id/upload/parts` returns `200 { parts: [{ partNumber, etag, size }] }` from `ListParts`, paginated internally, for resume. (4) `POST /videos/:id/upload/complete` takes `{ parts: [{ partNumber, etag }] }` (exactly partCount entries, ascending). The sequence is: `CompleteMultipartUpload`, then `HeadObject`, then the size check, then `draft → processing` (clears `upload_id`, sets `processing_started_at`) and commit, then enqueue (TD-13). It returns `200 { id, slug, status: 'processing' }`. A repeated call on a `processing` video returns the same 200 and re-adds the deterministic job (idempotent). On `ready`/`failed` it returns `409 VIDEO_UPLOAD_NOT_ACTIVE`. Storage `InvalidPart`/`InvalidPartOrder` returns `400 UPLOAD_PARTS_INVALID`; the video stays `draft` and the client can resume. If `HeadObject` size ≠ declared size, the object is deleted, the video becomes `failed`/`UPLOAD_SIZE_MISMATCH`, and the call returns `422 UPLOAD_SIZE_MISMATCH`. (5) `DELETE /videos/:id/upload` (user abort) is allowed only in `draft`. It calls `AbortMultipartUpload` (`NoSuchUpload` is tolerated) and moves the row to `failed` with `failure_reason = 'UPLOAD_ABORTED'` and `upload_id = null`. It returns `204`; on a non-`draft` video it returns `409 VIDEO_UPLOAD_NOT_ACTIVE`. Routes (2), (3) and (5) on a non-`draft` video also answer `409 VIDEO_UPLOAD_NOT_ACTIVE`. Rationale: validation AMB-5. Cross-layer TDs feed `### API Contracts`. An abort kept as `failed` with a reason mirrors TD-04's `UPLOAD_EXPIRED`, keeps the operation idempotent and auditable, and leaves hard deletion of videos to Phase 04 (video management).
- 2026-11-07 — Title default and column (IC-2, user-decided 2026-11-07): `title` is stored in `title varchar(100) NOT NULL`. A provided `title` is trimmed and must be 1–100 characters after trimming (`400` validation error otherwise). `filename` stays 1–255 characters, must contain at least one non-whitespace character, and is stored unchanged in `original_filename` (TD-09). If `title` is omitted, the default is derived from `filename`: drop the last extension (the substring from the last `.` to the end, when there is a `.`), trim, and cut to 100 characters. If that result is empty (e.g. `.mp4`), use the full `filename`, trimmed and cut to 100 characters. Cuts count Unicode code points (`Array.from(s).slice(0, 100)`), which matches how PostgreSQL counts `varchar(n)` characters and never splits a surrogate pair. Rationale: validation IC-2. The default must satisfy the same 1–100 rule as an explicit title.
- 2026-11-07 — Completion crash window (AMB-7, user-decided 2026-11-07): `POST /videos/:id/upload/complete` on a `draft` row treats `NoSuchUpload` from `CompleteMultipartUpload` as "possibly already completed" (the process died, or the DB commit failed, after storage completed). It runs `HeadObject` on `videos/{id}/original` with the internal client. If the object exists, the normal sequence continues: size check (mismatch → delete object, `failed`/`UPLOAD_SIZE_MISMATCH`, `422 UPLOAD_SIZE_MISMATCH`), then `draft → processing` and commit, then enqueue (TD-13), returning `200 { id, slug, status: 'processing' }`. If it is missing (`NotFound`), the call answers `409 VIDEO_UPLOAD_NOT_ACTIVE`; the row stays `draft` and the TD-04 sweeper later expires it (`UPLOAD_EXPIRED`). `GET /videos/:id/upload/parts` on a `draft` row whose `ListParts` returns `NoSuchUpload` also answers `409 VIDEO_UPLOAD_NOT_ACTIVE`; the client then calls `complete` (which recovers as above) or starts a new upload. No new error code: `VIDEO_UPLOAD_NOT_ACTIVE` already means "this video has no active upload session". For the same crash window, the user abort (`DELETE /videos/:id/upload`, AMB-5) also issues `DeleteObject` on `videos/{id}/original` after `AbortMultipartUpload` (idempotent, succeeds when the object is absent), so no orphan original is left, matching the TD-04 expiry steps. S3 errors are matched by `err.name` (`NoSuchUpload`; `NotFound` for a 404 `HeadObject`), see library-refs.md. Rationale: validation AMB-7. This makes TD-13's "idempotent completion" hold across the gap between the storage complete and the DB commit.
- 2026-11-07 — Owner status read (AMB-9, user-decided 2026-11-07): Phase 03 adds a minimal `GET /videos/:id` so the uploader can follow processing over HTTP. It is authenticated (global JWT guard, not `@Public()`) and owner-scoped like the upload routes: a missing video, or one not owned by the caller's channel, answers `404 VIDEO_NOT_FOUND`. It answers in every status (`draft`, `processing`, `ready`, `failed`) with `200 { id, slug, title, status, failureReason, originalFilename, contentType, sizeBytes, durationMs, width, height, videoCodec, createdAt, updatedAt }`. The fields map to the columns of TD-09/TD-12 (`failure_reason`, `original_filename`, `content_type`, `size_bytes`, `duration_ms`, `width`, `height`, `video_codec`) plus `created_at`/`updated_at` (`@CreateDateColumn`/`@UpdateDateColumn`, as in `users`/`channels`). `failureReason` and the four media fields are `null` until set, and `sizeBytes` is a JSON number. `upload_id`, `thumbnail_key` and `processing_started_at` are not exposed. There is no thumbnail URL: no Phase 03 route serves thumbnails (TD-05 keeps the bucket private, TD-11 covers only the video), and a thumbnail URL is a new contract that belongs with the Phase 04/05 listing and public page. `:id` is validated as a UUID (`ParseUUIDPipe`, `400` on malformed input) on this route and on the upload sub-routes, so a malformed id never reaches a uuid-typed query. Listing ("my videos"), editing title/metadata and deleting videos stay in Phase 04 (video management and the channel admin panel). Rationale: validation AMB-9. It closes the upload loop for clients and lets the e2e flow "upload → processing → ready → stream" be checked over HTTP instead of through the repository.

### phase-03-videos/TD-04

**Recommendation:** Application sweeper + storage-native expiry as safety net — keeps the `videos` table truthful and storage bounded using the queue already in place; the threshold should be configurable via env (e.g., 24h).

**Libraries:** —

**Revisions:**

- 2026-11-07 — Draft expiry spec and sweeper queue (AMB-6, user-decided 2026-11-07): the sweeper runs on its own BullMQ queue, `video-maintenance`, not on `video-processing`. The worker app context (TD-08) registers it with its own processor (`@Processor('video-maintenance', { concurrency: 1 })`) and `defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: { count: 100 } }`; a failed sweep is simply redone at the next tick. On boot the worker calls `upsertJobScheduler('video-sweeper', { every: VIDEO_SWEEPER_INTERVAL_MS }, { name: 'sweep', data: {} })` on `video-maintenance` (idempotent). Each sweep runs two branches: the `processing` reconciliation of TD-13 and the draft expiry below. Draft expiry selects `status = 'draft' AND created_at < now() - VIDEO_UPLOAD_EXPIRE_AFTER_MS` (default 24 h, the same as the storage-native `stale_uploads_expiry` backstop and far above the 1 h part-URL TTL). For each row: (1) `AbortMultipartUpload` with the stored `upload_id` (`NoSuchUpload` tolerated); (2) `DeleteObject` on `videos/{id}/original` (idempotent; the object can exist after the TD-03 AMB-7 crash window); (3) guarded `UPDATE videos SET status = 'failed', failure_reason = 'UPLOAD_EXPIRED', upload_id = NULL WHERE id = :id AND status = 'draft'`. Any other storage error skips that row (logged) until the next tick. Env vars, validated in the Joi schema with these defaults: `VIDEO_SWEEPER_INTERVAL_MS` = 900000 (15 min), `VIDEO_PROCESSING_STUCK_AFTER_MS` = 1800000 (30 min), `VIDEO_UPLOAD_EXPIRE_AFTER_MS` = 86400000 (24 h). Rationale: validation AMB-6. A dedicated queue keeps sweeps from waiting behind CPU-bound video jobs on the concurrency-1 processor, and keeps the `video-processing` retry options and the TD-12 `failed` handler away from sweep jobs.

### phase-03-videos/TD-05

**Recommendation:** Single private bucket, `videos/{videoId}/…` — the simplest layout that satisfies Phase 03; serving thumbnails publicly is a listing concern for later phases and can be added as a prefix policy without moving objects. Original file extension/content-type is preserved as object metadata, not in the key.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Internal endpoint for operations, public endpoint for presigning — the standard fix for SigV4 host binding that works the same in Docker and in production without host hacks; wrap both clients behind a single storage service so callers never choose.

**Libraries:** `@aws-sdk/client-s3@^3.1161.0`, `@aws-sdk/s3-request-presigner@^3.1161.0`

**Revisions:**

- 2026-11-04 — Testing override (IC-1, user-decided): inside containers (integration/e2e suites in `nestjs-api`, and the `video-worker`), presigned URLs that the container itself consumes are signed with the internal endpoint. The test env sets `S3_PUBLIC_ENDPOINT` equal to `S3_ENDPOINT` (`http://minio:9000`), so e2e tests can PUT presigned parts and follow the stream/download 302 from inside the container. The worker always signs its ffprobe/ffmpeg GET URLs with the internal client. Rationale: a SigV4 presigned URL binds the host, so a URL signed for `localhost:9000` is unreachable from inside a container.

### phase-03-videos/TD-07

**Recommendation:** `pgsty/silo`, pinned `RELEASE.*` tag — a pullable, pinned, maintained drop-in that keeps the "MinIO locally" premise and its env/command conventions; since all code talks S3 via the AWS SDK, swapping the image later costs only a Compose change. Bucket creation can be a one-shot `pgsty/mc` init service or an idempotent `CreateBucket` at app startup (implementation detail for the plan).

**Libraries:** `pgsty/silo:RELEASE.2026-10-26T00-00-00Z`, `pgsty/mc:RELEASE.2026-10-26T00-00-00Z` (Docker images)

**Revisions:**

- 2026-11-04 — Testing override (IC-1, user-decided): storage-dependent services, the worker and e2e tests run against this real Silo Compose service via `S3_ENDPOINT=http://minio:9000` (the Compose service name). No local-filesystem storage adapter is built: for this phase this overrides `testing-guide-nestjs-project` `references/external-systems.md` ("use the local filesystem adapter"). There are no `localhost` defaults. The bucket is created idempotently before use (init service or startup `CreateBucket`), and tests isolate by unique `videos/{videoId}/` keys. Image pin refreshed to the latest Silo/mc release available on 2026-11-04 (`RELEASE.2026-10-26T00-00-00Z`). Rationale: a filesystem adapter cannot exercise presigned multipart, `ListParts`, `HeadObject`, endpoint signing or the presigned GET that ffmpeg reads (TD-02/06/09/11), so tests would not cover the contracts the phase delivers.

### phase-03-videos/TD-08

**Recommendation:** Same codebase, separate entrypoint and `video-worker` Compose service — gives process/container isolation required by the architecture while reusing the existing entities, config and storage code with a single quality pipeline. Worker concurrency starts at 1 (configurable via env) since each job is CPU-bound.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Apt ffmpeg + `execFile` wrapper + presigned GET input — avoids a 10GB local copy and any deprecated wrapper, keeps the worker image simple; if HTTP seeking proves slow or flaky in tests, Option B is a contained fallback inside the same wrapper. ffprobe failure (non-video file) is a non-retryable error (TD-12).

**Libraries:** `ffmpeg` / `ffprobe` 5.1.x (Debian 12 bookworm apt package `ffmpeg`, `7:5.1.9-0+deb12u1` on 2026-11-04)

**Revisions:**

- 2026-11-04 — _(proposed by plan-resolve — confirmed by user 2026-11-04)_ Persisted metadata (AMB-2). Columns on `videos` set at upload start: `original_filename varchar(255) NOT NULL` (download `Content-Disposition`, TD-11), `content_type varchar(127) NOT NULL` (declared `video/*`), and `size_bytes bigint NOT NULL` (declared, re-verified with `HeadObject` at completion; mapped to `number` via a column transformer since ≤ 10 GiB < 2^53). Columns set by the worker on `processing → ready` (nullable until then): `duration_ms integer` (`round(format.duration × 1000)` from ffprobe), `width integer` and `height integer` (coded dimensions of the first `codec_type = video` stream; rotation side-data ignored in Phase 03), and `video_codec varchar(32)` (that stream's `codec_name`). Not persisted: bitrate, frame rate, audio streams, container `format_name` and the raw ffprobe JSON (no Phase 03 consumer). Invalid media → `UnrecoverableError` with reason `INVALID_MEDIA`. That covers ffprobe exiting non-zero or with unparsable JSON, no video stream, or a missing/non-positive duration. Rationale: validation AMB-2. This is the minimal set that satisfies "extração de duração e metadados" and gives later phases (player, listings) dimensions and codec without a new migration.
- 2026-11-04 — _(proposed by plan-resolve — confirmed by user 2026-11-04)_ Thumbnail parameters (AMB-3). Frame offset `t = min(1 s, duration / 2)`, using input seeking (`-ss t` before `-i`) so only nearby bytes are fetched over HTTP. Command: `ffmpeg -v error -ss <t> -i <internal presigned GET> -frames:v 1 -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2" -q:v 3 -f mjpeg pipe:1`. That is a JPEG that fits inside 1280×720, keeps the aspect ratio, never upscales and has even dimensions; the filter options were verified on the bookworm 5.1.9 binary. stdout is collected via `execFile` with `maxBuffer` 10 MiB and uploaded with `PutObject` to `videos/{videoId}/thumbnail.jpg` (`ContentType: image/jpeg`); the key goes in `thumbnail_key varchar(255)`. Fallback: if no frame comes back at `t > 0`, retry once at `t = 0` within the same attempt. If that also yields nothing → `UnrecoverableError` with reason `THUMBNAIL_FAILED`, and the whole job fails: a `ready` video always has a thumbnail. Transient errors (storage/network, `execFile` timeout of 120 s per ffprobe/ffmpeg call) are thrown normally and retried per TD-12. Rationale: validation AMB-3. The capability requires a thumbnail, and a single `ready` invariant (metadata + thumbnail present) is simpler for later consumers than a partially processed `ready`.
- 2026-11-07 — Transient vs. permanent failure classification (AMB-10, user-decided 2026-11-07): this refines the "ffprobe exiting non-zero → `INVALID_MEDIA`" rule (AMB-2 revision) and the "no frame → `THUMBNAIL_FAILED`" rule (AMB-3 revision). (1) Before ffprobe, the worker runs `HeadObject` on `videos/{videoId}/original` with the internal client. `NotFound` → `UnrecoverableError` with reason `SOURCE_MISSING`: the object was verified at completion, so its absence is permanent and a retry cannot help. Any other `HeadObject` error (network, 5xx, timeout) is thrown normally and retried per TD-12. (2) The internal presigned GET for ffprobe/ffmpeg is signed fresh at the start of each attempt (TTL 15 min, internal client). (3) An `execFile` timeout (120 s) is transient. On a non-zero exit, stderr is matched case-insensitively against the transient list below. A match → a normal `Error`, retried; once the 3 attempts are used up, the TD-12 handler writes `PROCESSING_FAILED`. No match → `UnrecoverableError` with `INVALID_MEDIA` (ffprobe). For the thumbnail, no match → the t = 0 fallback, then `THUMBNAIL_FAILED`. A transient match at t > 0 is thrown at once, without the t = 0 fallback. Unchanged: ffprobe exit 0 with unparsable JSON, no video stream or a missing/non-positive duration → `INVALID_MEDIA`; ffmpeg exit 0 with empty stdout → fallback, then `THUMBNAIL_FAILED`. Transient stderr patterns (FFmpeg HTTP/TCP messages; keep them in one exported constant): `Connection refused`, `Connection reset`, `timed out` (covers `Connection timed out`), `Server returned 5` (any 5XX), `Server returned 403` (expired/invalid signature, re-signed on retry), `Input/output error`, `I/O error`, `Failed to resolve hostname`. Rationale: validation AMB-10. ffprobe/ffmpeg read the input over HTTP, so without this a storage outage would be recorded as a permanently invalid file.

### phase-03-videos/TD-10

**Recommendation:** Random 11-char base64url with unique constraint and retry — short, unguessable, dependency-free, and the DB constraint makes "sem conflito" a hard guarantee rather than a probability.

**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** 302 redirect to short-lived presigned GET, with `ResponseContentDisposition` for download — delegates Range/206 to the storage that already implements it, keeps the API out of the data path, and matches the architecture diagram; only `ready` videos are redirectable (TD-12).

**Libraries:** `@aws-sdk/s3-request-presigner@^3.1161.0`

**Revisions:**

- 2026-11-07 — Stream/download contract (AMB-8, user-decided 2026-11-07): both routes are `@Public()` (TD-14) and take the TD-10 slug. (1) `GET /videos/:slug/stream` → `302 Found` with `Location` = a presigned `GetObject` URL for `videos/{id}/original`, signed with the public client (TD-06) and `expiresIn: 3600` (1 h, the same TTL as the part URLs; long enough for a typical viewing session, and the player re-requests the route when it expires). No response overrides: the object already carries the declared `content_type` (set by `CreateMultipartUpload`), and storage answers `Range` with `206`. (2) `GET /videos/:slug/download` → `302` to the same kind of URL (TTL 3600 s) with `ResponseContentDisposition = attachment; filename="<ascii>"; filename*=UTF-8''<encoded>` (RFC 6266 / RFC 5987). The filename is the sanitized `title` plus the original extension. The extension is the last `.ext` of `original_filename` (TD-09), lower-cased, kept only if it matches `^[a-z0-9]{1,10}$` and omitted otherwise. To sanitize the title: remove control characters and `/ \ : * ? " < > |`, collapse whitespace, trim spaces and trailing dots, and use `video` if nothing is left. `<encoded>` is that name percent-encoded (`encodeURIComponent`, plus `'`, `(`, `)`, `*`); `<ascii>` is the same name with each non-ASCII character replaced by `_`. (3) Both routes answer `404 VIDEO_NOT_FOUND` for an unknown slug **and** for a video that is not `ready` (`draft`, `processing`, `failed`), the same code for both, so the state of a non-public video is not revealed. (4) The 302 response carries `Cache-Control: no-store`, so a cached redirect never outlives its signed URL. Rationale: validation AMB-8. Cross-layer TDs feed `### API Contracts`. The 1 h TTL is a user decision; library-refs.md was updated from 300 s.

### phase-03-videos/TD-12

**Recommendation:** Single `draft → processing → ready | failed` enum, 3 attempts with exponential backoff, `UnrecoverableError` for invalid media, terminal `failed` with reason — the minimal lifecycle that satisfies the acceptance criterion and stays idempotent under redelivery; reprocess (B) can be added later via `/decide` if real transient failures show up. Failed BullMQ jobs are retained (`removeOnFail` with a count) for inspection.

**Libraries:** —

**Revisions:**

- 2026-11-04 — Status semantics (AMB-4, user-decided): `status` is the processing lifecycle only. `draft` = pre-registered, upload not yet completed. The Phase 03 "rascunho" capability is satisfied by the pre-registered row. The enum keeps `draft | processing | ready | failed` because the exercise's acceptance criterion literally names "rascunho → processando → pronto/erro". Phase 04 adds an independent publication/visibility field and does not reuse or rename this enum. `failure_reason varchar(32) NULL` holds one of `UPLOAD_EXPIRED` (TD-04), `UPLOAD_ABORTED` and `UPLOAD_SIZE_MISMATCH` (TD-03), `INVALID_MEDIA` and `THUMBNAIL_FAILED` (TD-09), and `PROCESSING_FAILED` (retries exhausted / stalled / sweeper). It is typed as a TS union, not a PG enum, so codes can be added without an enum migration. Rationale: validation AMB-4. This avoids overloading `draft` with Phase 04's "unpublished" meaning.
- 2026-11-04 — _(proposed by plan-resolve — confirmed by user 2026-11-04)_ Terminal failure write (AMB-1). The terminal `processing → failed` write lives in the processor's `@OnWorkerEvent('failed')` handler (`@nestjs/bullmq`), not in `process()`. It acts when `job` is defined and either the error is an `UnrecoverableError` or `job.attemptsMade >= job.opts.attempts`. It runs a guarded `UPDATE videos SET status='failed', failure_reason=<code> WHERE id = job.data.videoId AND status='processing'`. `<code>` is the processing error's domain code (`INVALID_MEDIA` / `THUMBNAIL_FAILED`) or `PROCESSING_FAILED` otherwise. The handler never throws; it logs its own errors. Job options: `attempts: 3`, `backoff: { type: 'exponential', delay: 10000 }`, `removeOnComplete: true`, `removeOnFail: { count: 1000 }`. The `failed` event may carry `job === undefined`, as with jobs failed for exceeding `maxStalledCount` (default 1); those are reconciled by the TD-13 sweeper. Rationale: validation AMB-1. One place covers both thrown-error paths; the sweeper covers the cases the event cannot (BullMQ docs v6.5.3: Workers/events, Stalled jobs, Stop retrying jobs).
- 2026-11-07 — Failed-handler guard and failure codes (AMB-6, AMB-10, user-decided 2026-11-07): the `@OnWorkerEvent('failed')` handler exists only on the `video-processing` processor. Sweep jobs run on the separate `video-maintenance` queue (TD-04 revision) and never reach it. As defence in depth, the handler returns without writing when `job` is `undefined` or `job.data.videoId` is not a non-empty string: TypeORM drops `undefined` criteria from `where`, so an unguarded `update({ id: undefined, status: 'processing' }, …)` would fail every `processing` video. The `failure_reason` codes are now `UPLOAD_EXPIRED` (TD-04), `UPLOAD_ABORTED` and `UPLOAD_SIZE_MISMATCH` (TD-03), `INVALID_MEDIA`, `THUMBNAIL_FAILED` and `SOURCE_MISSING` (TD-09), and `PROCESSING_FAILED` (retries exhausted, including transient storage/ffprobe/ffmpeg errors; stalled jobs; sweeper). Rationale: validation AMB-6 and AMB-10.

### phase-03-videos/TD-13

**Recommendation:** Commit, then enqueue with `jobId = videoId`; idempotent completion; sweeper backstop — closes the dual-write gap with mechanisms already chosen (BullMQ dedupe + TD-04 scheduler) without introducing an outbox. If pg-boss were chosen in TD-01 instead, the enqueue could share the DB transaction and this TD would collapse.

**Libraries:** —

**Revisions:**

- 2026-11-04 — _(proposed by plan-resolve — confirmed by user 2026-11-04)_ Sweeper reconciliation for `processing` (AMB-1). The TD-04 Job Scheduler (`upsertJobScheduler('video-sweeper', { every: VIDEO_SWEEPER_INTERVAL_MS })`, default 15 min) also scans videos in `processing` whose `processing_started_at` (new `timestamptz NULL` column, set on `draft → processing`) is older than `VIDEO_PROCESSING_STUCK_AFTER_MS` (default 30 min). For each, it calls `queue.getJob(videoId)` and `job.getState()`. (a) Job missing / state `unknown` (the dual-write gap or an evicted job): re-add with `jobId = videoId`. (b) State `failed`: write terminal `failed`/`PROCESSING_FAILED` with the same guarded UPDATE. There is no remove-and-re-add, consistent with "no reprocess" in TD-12, and the retained failed job is why a plain re-add would be a silent no-op. (c) State `completed` while the row is still `processing` (anomaly): `job.remove()` then re-add. (d) `waiting` / `delayed` / `prioritized` / `active` / `waiting-children`: leave it alone. Known edge: if `removeOnFail` evicted a failed job before the sweeper saw it, the video is re-enqueued once more (bounded by 3 attempts). Rationale: validation AMB-1. BullMQ ignores `add` for an existing `jobId`, including retained failed/completed jobs, so the sweeper must branch on job state.
- 2026-11-07 — Sweeper queue (AMB-6, user-decided 2026-11-07): the `video-sweeper` Job Scheduler lives on the dedicated `video-maintenance` queue (TD-04 revision), not on `video-processing`. The maintenance processor injects the processing queue (`@InjectQueue('video-processing')`) to run the `getJob` / `getState` / re-add branches above, so the worker app context registers both queues (`BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: <TD-12 options> }, { name: 'video-maintenance', defaultJobOptions: <TD-04 options> })`). The env names are unchanged (`VIDEO_SWEEPER_INTERVAL_MS`, `VIDEO_PROCESSING_STUCK_AFTER_MS`); the same sweep also runs the TD-04 draft expiry (`VIDEO_UPLOAD_EXPIRE_AFTER_MS`). Rationale: validation AMB-6.

### phase-03-videos/TD-14

**Recommendation:** Public by unique slug, `ready` only — consistent with the platform's anonymous-viewing premise and with TD-10's unguessable ids, and keeps the stream/download contract stable for Phase 05; Phase 04 then adds the publication/visibility gate. Upload and completion endpoints remain authenticated and owner-scoped.

**Libraries:** —

**Revisions:**

- 2026-11-04 — Phase 04 boundary (AMB-4, user-decided): the Phase 03 gate for public stream/download is `status = 'ready'` only. Phase 04 adds the separate publication/visibility field (TD-12 revision) and tightens these same routes to also require publication. The route shapes and the 302 contract (TD-11) do not change. Rationale: validation AMB-4. It makes the planned behaviour change explicit so Phase 04 plans it rather than discovers it.
- 2026-11-07 — Non-`ready` response (AMB-8, user-decided 2026-11-07): Option A's "`404`/`409`" becomes `404 VIDEO_NOT_FOUND`, the same as an unknown slug (TD-11 revision). Rationale: validation AMB-8. A public, unauthenticated route should not reveal whether a non-public video exists or what state it is in.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** @nestjs/swagger

**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory 03 and then rerun /plan-context 03 to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` — §3 Feature Implementation Checklist)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_(from `testing-guide-nestjs-project` — `artifacts/future-types.md`, artifact types this phase is expected to introduce)_

| Artifact type | Required layers |
|---------------|-----------------|
| Queue consumer / processor with business logic | Unit (mock deps) + Integration (real DB/storage) |
| Queue consumer / processor with only external system calls | Integration (real systems) |
| Scheduled task | Unit and/or Integration on the method itself — do not test that the schedule triggers |

**Phase 03 testing override** _(validation IC-1, user-decided 2026-11-04; recorded as `**Revisions:**` on phase-03-videos/TD-01, TD-06, TD-07)_. These rules take precedence over the guide rows above:

- **Storage:** the "or local adapter" option in the *Service with side-effect dep* row does **not** apply. Storage-dependent services, the video worker/processor and e2e tests run against the real Silo (MinIO) Compose service via `S3_ENDPOINT=http://minio:9000`. No local-filesystem storage adapter is built.
- **Queue:** queue producers, the processor and the sweeper run against the real Redis Compose service via `REDIS_HOST=redis`. There is no in-memory queue fake.
- **Hosts:** no `localhost` defaults in config factories, Joi schema defaults or test helpers; always use Compose service names (root `CLAUDE.md` Docker networking).
- **Presigned URLs in containers:** URLs that a container consumes itself (e2e part PUTs, following the stream/download 302, worker ffprobe/ffmpeg input) are signed with the internal endpoint. The test env sets `S3_PUBLIC_ENDPOINT` = `S3_ENDPOINT`.
- Updating `testing-guide-nestjs-project` (`references/external-systems.md`) to match is a separate follow-up, out of scope for this phase.

### next-frontend

_Deferred subproject — no video UI in this phase; testing requirements will be defined when a phase brings the video screens._
