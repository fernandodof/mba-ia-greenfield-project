---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-21
scope_description: "Backend foundation for video upload and processing: queue technology, direct-to-storage 10GB multipart upload with draft pre-registration, object-storage usage (layout, presigned endpoints, local MinIO image), video worker topology and FFmpeg integration, unique video URL, streaming/download delivery, and video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (upload session endpoints, completion, stream/download endpoints), the video worker (same codebase, separate process/container), the migration for the `videos` table, and the new Compose infrastructure (object storage, queue, worker).
- `next-frontend/` — Frontend deferred: Phase 03 is backend-only per the exercise scope (the video UI is not part of this phase). Cross-layer TDs below (TD-02, TD-03, TD-11) define the HTTP/storage contract the future frontend will consume through its BFF (`next-frontend-config-base/TD-03`); no frontend implementation decision is open in this document.

**Given (not evaluated here):** object storage is S3-compatible — MinIO locally in Docker, AWS S3 in production (`docs/project-plan.md` architecture + exercise statement). Inherited constraints: `@nestjs/config` + Joi env validation with `registerAs` namespaces (`phase-01-configuracao-base/TD-01..TD-04`), JWT custom guard (`phase-02-auth/TD-02`), class-validator DTOs (`phase-02-auth/TD-06`), `{ statusCode, error, message }` domain error contract (`phase-02-auth/TD-07`), `@nestjs/throttler` (`phase-02-auth/TD-08`), strict BFF on the frontend side (`next-frontend-config-base/TD-03`).

**Installed baseline checked (`nestjs-project/package.json`, `Dockerfile.dev`):** `@nestjs/common|core ^11.0.1`, `typeorm ^0.3.28`, `pg ^8.20.0`, `@nestjs/config ^4.0.3`; image `node:25.6.0-slim` (Debian 12 bookworm); PostgreSQL 17. No queue, storage or media library installed yet.

---

## TD-01: Queue Technology for Video Processing Jobs

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and the C4 diagram leave the Message Queue as "TBD" — this is the main open stack decision of the phase. The API publishes a "process video" job after upload completion; the Video Worker consumes it, runs FFmpeg (minutes for large files), and updates DB/storage. Needs: retries with backoff, job de-duplication (one active job per video), visibility of failed jobs, and a recurring job for cleanup (TD-04). The queue must run as real infrastructure in Docker Compose (exercise acceptance criteria). The project's own `nestjs-best-practices` skill (`rules/micro-use-queues.md`) already prescribes `@nestjs/bullmq`.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq`)
- Official NestJS queue integration (docs.nestjs.com/techniques/queues). `BullModule.forRootAsync` + `registerQueue`; producers inject `Queue`, the worker extends `WorkerHost` with `@Processor`. New `redis` Compose service. `@nestjs/bullmq@12.0.0` peer-supports Nest 11 and `bullmq` 5.x/6.x (BullMQ 6 makes `ioredis` an explicit peer install).
- **Pros:** First-party Nest docs and the project's best-practices skill already use it. Built-in `attempts` + exponential backoff, custom `jobId` (dedupe per video), Job Schedulers (cron-like, for TD-04), stalled-job recovery, `QueueEvents`. Most battle-tested option (BullMQ docs: "Redis backend remains the default and the most battle-tested"). Queue is a distinct, visible Compose container — matches the C4 "Message Queue" container.
- **Cons:** New infrastructure (Redis) to run and configure correctly (`maxmemory-policy noeviction` is mandatory, AOF recommended — BullMQ "Going to production"). Enqueue is not transactional with PostgreSQL (dual write — handled in TD-13).

### Option B: pg-boss on the existing PostgreSQL
- Queue implemented as tables in PostgreSQL (`SKIP LOCKED`), `pg-boss@12.x` (Node ≥ 22.12, PostgreSQL ≥ 13). No extra container; the job can be inserted in the same DB transaction that moves the video to `processing`.
- **Pros:** Zero new infrastructure. Transactional enqueue eliminates the dual-write problem. Retries/backoff, dead-letter queues, cron scheduling built in.
- **Cons:** No official NestJS module — custom provider/lifecycle wiring (community wrappers only). Job polling load lands on the same PostgreSQL that serves the API. "Queue" is not a distinct Compose service — weaker fit with the C4 diagram and with the exercise's "fila … subindo no Compose" criterion.

### Option C: RabbitMQ (`@nestjs/microservices` RMQ transport or `@golevelup/nestjs-rabbitmq`)
- AMQP broker as a new Compose service; API publishes a message, worker is a Nest microservice consumer with manual ack.
- **Pros:** Real message broker, language-agnostic, strong routing (exchanges), durable queues.
- **Cons:** Nest RMQ transport has no built-in retry/backoff/delay or job state — requires DLX + TTL topologies and hand-rolled attempt tracking. No job-level introspection ("which video failed and why"). Heavier operationally than Redis for a single job type.

### Option D: BullMQ 6 with its PostgreSQL backend
- BullMQ 6.0 (released 2026-07-30) added a pluggable `IQueueBackend`; `createPostgresBackend` runs the same Queue/Worker API on PostgreSQL ≥ 13 (14+ recommended), with explicit `runMigrations()`.
- **Pros:** BullMQ semantics without Redis. Could reuse the existing PostgreSQL 17.
- **Cons:** Under three months old. `@nestjs/bullmq@12.0.0` constructs `new Queue(name, opts)` / `new Worker(name, processor, opts)` without the backend-factory argument (verified in the package's `dist/bull.providers.js` and `dist/bull.explorer.js`), so the Nest integration cannot use it — raw classes and manual wiring would be required. Docs report ~1.5–2× lower throughput than Redis.

**Recommendation:** **Option A (BullMQ on Redis via `@nestjs/bullmq`)** — it is the official Nest path already prescribed by the project's best-practices skill, offers per-video `jobId` dedupe, retries/backoff and Job Schedulers out of the box, and makes the queue a real, separate Compose service as the architecture and acceptance criteria expect; the cost is one Redis container plus the dual-write handling in TD-13. pg-boss (B) is the strongest alternative if avoiding new infrastructure matters more than official Nest integration. Exact `bullmq` major (5.x vs 6.x) is a library-pinning concern for `plan-resolve`.

**Decision:** A (BullMQ on Redis via `@nestjs/bullmq`)
**Libraries:** `@nestjs/bullmq@^12.0.0`, `bullmq@^6.6.1`, `ioredis@^5.11.1`, `redis:8.10.3-alpine` (Docker image)

**Revisions:**

- 2026-11-04 — Testing override (IC-1, user-decided): queue producers, the video processor and the sweeper scheduler are integration/e2e-tested against the real Redis Compose service, addressed by its Compose service name (`REDIS_HOST=redis`). There is no in-memory queue fake and no `localhost` default in config factories, Joi defaults or test helpers. Redis runs with `maxmemory-policy noeviction`; worker connections keep ioredis `maxRetriesPerRequest: null` (BullMQ default for workers). `ioredis` is pinned to the 5.x line BullMQ 6 is tested against (`bullmq` devDependency `ioredis@5.11.1`), not the new 6.0.0 major. Rationale: the `testing-guide-nestjs-project` connection example (`REDIS_HOST ?? 'localhost'`) contradicts the root CLAUDE.md Docker-networking rule and the exercise's "não mocke o que dá para testar com a infra do Compose"; updating the guide itself is a separate follow-up.

---

## TD-02: Upload Protocol for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The API must not hold the request (or the bytes) during a 10GB upload — passing the file through the API is an automatic failure in the exercise. `docs/project-plan.md` § Pontos de Atenção also asks that the upload "permita retomar em caso de falha de conexão". Hard storage limits (AWS S3 multipart limits page): a single PUT is capped at 5 GiB, multipart parts are 5 MiB–5 GiB (last part unbounded), max 10,000 parts. Cross-layer because the handshake (init → parts → complete) is executed by the client and the API together.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (direct to storage)
- API calls `CreateMultipartUpload` and returns presigned `UploadPart` URLs (`@aws-sdk/s3-request-presigner` `getSignedUrl`); the client PUTs each part straight to MinIO/S3 and collects the `ETag`s; the API then calls `CompleteMultipartUpload`. Uploaded parts can be listed (`ListParts`) to resume after a connection drop.
- **Pros:** Bytes never touch the API (it only signs URLs — pure CPU, no I/O). Works on real S3 for 10GB (single PUT cannot). Resumable and parallelizable per part. Same code against MinIO and S3.
- **Cons:** Multi-step contract (init / sign parts / complete / abort). Browser clients need CORS with `ETag` exposed. Total size cannot be enforced by the URL itself — must be checked by the API (part count at signing, `HeadObject` at completion).

### Option B: Single presigned PUT (or presigned POST with `content-length-range`)
- API returns one presigned URL; client uploads the whole file in one request.
- **Pros:** Simplest contract (one URL). POST policy can enforce max size at the storage edge.
- **Cons:** Fails the requirement on AWS S3 (single upload ≤ 5 GiB). Not resumable — a dropped connection at 9GB restarts from zero.

### Option C: tus resumable protocol (`@tus/server` + `@tus/s3-store`)
- A tus endpoint (in the API or a sidecar) receives chunks and streams them into S3 multipart.
- **Pros:** Standard resumable protocol with mature clients (`tus-js-client`, Uppy).
- **Cons:** All 10GB still flow through our server process (network + CPU on the API/sidecar) — contradicts "sem passar o arquivo pela API". Extra server component and state store for upload offsets.

**Recommendation:** **Option A (S3 multipart with presigned part URLs)** — the only option that both keeps bytes off the API and supports 10GB on production S3, with resumability via `ListParts`. Suggested parameters for the plan: max declared size 10 GiB (10 × 1024³ bytes), fixed part size 64 MiB (≤ 160 parts for 10 GiB, well under 10,000), presigned URL TTL ~1h, size verified again with `HeadObject` before accepting completion. API shape and draft creation are in TD-03; cleanup in TD-04.

**Decision:** A (S3 multipart with presigned part URLs, direct to storage)
**Libraries:** `@aws-sdk/client-s3@^3.1161.0`, `@aws-sdk/s3-request-presigner@^3.1161.0`

**Revisions:**

- 2026-11-04 — _(library-pinning note from plan-resolve — confirmed by user 2026-11-04)_ Both `S3Client` instances (internal and public, TD-06) set `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'`, plus `forcePathStyle: true`. Rationale: since the SDK's default data-integrity protections (`WHEN_SUPPORTED`), `UploadPart`/`PutObject` get a default CRC32 checksum algorithm; presigned part URLs would then require checksum headers the client cannot compute per part, and S3-compatible servers may reject them (confirmed via Context7 `/aws/aws-sdk-js-v3`, flexible-checksums middleware).

---

## TD-03: Upload Session API Shape and Draft Pre-registration

**Scope:** Cross-layer

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The video row must exist as a draft as soon as the upload starts (before any byte is sent), owned by the uploader's channel. The REST shape of the upload session (TD-02 multipart steps) is the contract the future frontend BFF will call. Depends on TD-02.

**Options:**

### Option A: Single "start upload" call creates the draft and the multipart session
- `POST /videos` with `{ title?, filename, size, contentType }` validates size/type, inserts the video (`draft`, storage key, `upload_id`), calls `CreateMultipartUpload`, and returns `{ id, slug, partSize, partCount, uploadId }`. Then `POST /videos/:id/upload/parts` (sign a batch of part numbers), `GET /videos/:id/upload/parts` (resume: already uploaded parts), `POST /videos/:id/upload/complete` with `{ parts: [{ partNumber, etag }] }`, `DELETE /videos/:id/upload` (abort).
- **Pros:** Draft creation and upload start are one atomic user action — exactly the capability wording. One resource (`videos`) owns the upload state; no orphan "upload session" entity.
- **Cons:** Upload-specific columns (`upload_id`) live on the video row. If `CreateMultipartUpload` fails after insert, the draft must be rolled back (do the storage call before commit or inside the same unit of work).

### Option B: Two-step — create draft resource, then open an upload session
- `POST /videos` creates the draft metadata only; `POST /videos/:id/uploads` opens the multipart session (separate `video_uploads` table).
- **Pros:** Clean separation of video metadata vs. transfer state; supports re-upload of a file for the same video later.
- **Cons:** Two round-trips to start; a draft can exist without any upload (needs its own cleanup). Extra table/entity with no Phase 03 capability requiring re-upload.

### Option C: Draft created only at completion
- Upload session is tracked out-of-band (e.g., in Redis/queue state); the video row is inserted when the client calls complete.
- **Pros:** No half-finished rows in `videos`.
- **Cons:** Violates the capability ("pré-cadastro … ao iniciar o upload"). In-flight uploads are invisible to the channel.

**Recommendation:** **Option A (single start call creates draft + multipart session)** — matches the capability literally, keeps one resource and one table, and the extra `upload_id` column is cheap; Option B's flexibility (re-upload) is not required by any Phase 03 bullet. Endpoints are authenticated (global JWT guard) and the draft belongs to the caller's channel.

**Decision:** A (single start call creates draft + multipart session)
**Libraries:** —

**Revisions:**

- 2026-11-04 — _(proposed by plan-resolve — confirmed by user 2026-11-04)_ Upload-session contract carried into the plan (AMB-5). Re-extracted from Option A's body and completed. All routes are authenticated (global JWT guard). They are owner-scoped: a video not owned by the caller's channel answers `404 VIDEO_NOT_FOUND`, the same as a missing one. Errors use the `{ statusCode, error, message }` envelope (phase-02-auth/TD-07). (1) `POST /videos` takes `{ title?: string (1–100), filename: string (1–255), size: integer 1..10 GiB, contentType: string matching ^video/ }`. It returns `201 { id, slug, status: 'draft', partSize, partCount }`, with `partSize` = 64 MiB and `partCount = ceil(size / partSize)`. The S3 `uploadId` stays server-side on the row and is not exposed (refines the Option A sketch). If `title` is omitted it defaults to `filename` without extension. (2) `POST /videos/:id/upload/parts` takes `{ partNumbers: integer[] }` (unique, each 1..partCount, 1..partCount entries). It returns `200 { parts: [{ partNumber, url }], expiresAt }` (presigned `UploadPart`, TTL 1h, public endpoint). (3) `GET /videos/:id/upload/parts` returns `200 { parts: [{ partNumber, etag, size }] }` from `ListParts`, paginated internally, for resume. (4) `POST /videos/:id/upload/complete` takes `{ parts: [{ partNumber, etag }] }` (exactly partCount entries, ascending). The sequence is: `CompleteMultipartUpload`, then `HeadObject`, then the size check, then `draft → processing` (clears `upload_id`, sets `processing_started_at`) and commit, then enqueue (TD-13). It returns `200 { id, slug, status: 'processing' }`. A repeated call on a `processing` video returns the same 200 and re-adds the deterministic job (idempotent). On `ready`/`failed` it returns `409 VIDEO_UPLOAD_NOT_ACTIVE`. Storage `InvalidPart`/`InvalidPartOrder` returns `400 UPLOAD_PARTS_INVALID`; the video stays `draft` and the client can resume. If `HeadObject` size ≠ declared size, the object is deleted, the video becomes `failed`/`UPLOAD_SIZE_MISMATCH`, and the call returns `422 UPLOAD_SIZE_MISMATCH`. (5) `DELETE /videos/:id/upload` (user abort) is allowed only in `draft`. It calls `AbortMultipartUpload` (`NoSuchUpload` is tolerated) and moves the row to `failed` with `failure_reason = 'UPLOAD_ABORTED'` and `upload_id = null`. It returns `204`; on a non-`draft` video it returns `409 VIDEO_UPLOAD_NOT_ACTIVE`. Routes (2), (3) and (5) on a non-`draft` video also answer `409 VIDEO_UPLOAD_NOT_ACTIVE`. Rationale: validation AMB-5. Cross-layer TDs feed `### API Contracts`. An abort kept as `failed` with a reason mirrors TD-04's `UPLOAD_EXPIRED`, keeps the operation idempotent and auditable, and leaves hard deletion of videos to Phase 04 (video management).
- 2026-11-07 — Title default and column (IC-2, user-decided 2026-11-07): `title` is stored in `title varchar(100) NOT NULL`. A provided `title` is trimmed and must be 1–100 characters after trimming (`400` validation error otherwise). `filename` stays 1–255 characters, must contain at least one non-whitespace character, and is stored unchanged in `original_filename` (TD-09). If `title` is omitted, the default is derived from `filename`: drop the last extension (the substring from the last `.` to the end, when there is a `.`), trim, and cut to 100 characters. If that result is empty (e.g. `.mp4`), use the full `filename`, trimmed and cut to 100 characters. Cuts count Unicode code points (`Array.from(s).slice(0, 100)`), which matches how PostgreSQL counts `varchar(n)` characters and never splits a surrogate pair. Rationale: validation IC-2. The default must satisfy the same 1–100 rule as an explicit title.
- 2026-11-07 — Completion crash window (AMB-7, user-decided 2026-11-07): `POST /videos/:id/upload/complete` on a `draft` row treats `NoSuchUpload` from `CompleteMultipartUpload` as "possibly already completed" (the process died, or the DB commit failed, after storage completed). It runs `HeadObject` on `videos/{id}/original` with the internal client. If the object exists, the normal sequence continues: size check (mismatch → delete object, `failed`/`UPLOAD_SIZE_MISMATCH`, `422 UPLOAD_SIZE_MISMATCH`), then `draft → processing` and commit, then enqueue (TD-13), returning `200 { id, slug, status: 'processing' }`. If it is missing (`NotFound`), the call answers `409 VIDEO_UPLOAD_NOT_ACTIVE`; the row stays `draft` and the TD-04 sweeper later expires it (`UPLOAD_EXPIRED`). `GET /videos/:id/upload/parts` on a `draft` row whose `ListParts` returns `NoSuchUpload` also answers `409 VIDEO_UPLOAD_NOT_ACTIVE`; the client then calls `complete` (which recovers as above) or starts a new upload. No new error code: `VIDEO_UPLOAD_NOT_ACTIVE` already means "this video has no active upload session". For the same crash window, the user abort (`DELETE /videos/:id/upload`, AMB-5) also issues `DeleteObject` on `videos/{id}/original` after `AbortMultipartUpload` (idempotent, succeeds when the object is absent), so no orphan original is left, matching the TD-04 expiry steps. S3 errors are matched by `err.name` (`NoSuchUpload`; `NotFound` for a 404 `HeadObject`), see library-refs.md. Rationale: validation AMB-7. This makes TD-13's "idempotent completion" hold across the gap between the storage complete and the DB commit.
- 2026-11-07 — Owner status read (AMB-9, user-decided 2026-11-07): Phase 03 adds a minimal `GET /videos/:id` so the uploader can follow processing over HTTP. It is authenticated (global JWT guard, not `@Public()`) and owner-scoped like the upload routes: a missing video, or one not owned by the caller's channel, answers `404 VIDEO_NOT_FOUND`. It answers in every status (`draft`, `processing`, `ready`, `failed`) with `200 { id, slug, title, status, failureReason, originalFilename, contentType, sizeBytes, durationMs, width, height, videoCodec, createdAt, updatedAt }`. The fields map to the columns of TD-09/TD-12 (`failure_reason`, `original_filename`, `content_type`, `size_bytes`, `duration_ms`, `width`, `height`, `video_codec`) plus `created_at`/`updated_at` (`@CreateDateColumn`/`@UpdateDateColumn`, as in `users`/`channels`). `failureReason` and the four media fields are `null` until set, and `sizeBytes` is a JSON number. `upload_id`, `thumbnail_key` and `processing_started_at` are not exposed. There is no thumbnail URL: no Phase 03 route serves thumbnails (TD-05 keeps the bucket private, TD-11 covers only the video), and a thumbnail URL is a new contract that belongs with the Phase 04/05 listing and public page. `:id` is validated as a UUID (`ParseUUIDPipe`, `400` on malformed input) on this route and on the upload sub-routes, so a malformed id never reaches a uuid-typed query. Listing ("my videos"), editing title/metadata and deleting videos stay in Phase 04 (video management and the channel admin panel). Rationale: validation AMB-9. It closes the upload loop for clients and lets the e2e flow "upload → processing → ready → stream" be checked over HTTP instead of through the repository.

---

## TD-04: Abandoned / Incomplete Upload Cleanup

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** With TD-02/TD-03, a client may start an upload and never complete it. Uploaded parts of an unfinished multipart upload consume storage until aborted (`docs/project-plan.md` § Pontos de Atenção — "planejar o crescimento e os custos de armazenamento"), and the draft row stays in `draft` forever. Depends on TD-01 (scheduler) and TD-12 (status).

**Options:**

### Option A: Storage-native expiry only
- Rely on MinIO `api stale_uploads_expiry` (default 24h, swept every 6h) locally and an S3 lifecycle rule `AbortIncompleteMultipartUpload` in production.
- **Pros:** Zero application code; storage is guaranteed to be reclaimed.
- **Cons:** The DB row is never updated — drafts pointing to an upload that no longer exists stay in `draft` indefinitely. Behaviour depends on per-environment storage config.

### Option B: Application sweeper job + storage-native expiry as safety net
- A BullMQ Job Scheduler (TD-01) runs periodically (e.g., hourly) in the worker: drafts with an open `upload_id` older than a threshold (e.g., 24h) get `AbortMultipartUpload` and are moved to `failed` with reason `UPLOAD_EXPIRED`. Storage-native expiry stays as a backstop.
- **Pros:** DB and storage stay consistent; expiry is explicit, testable, and environment-independent. Reuses the queue infrastructure already chosen.
- **Cons:** One more job type and a threshold to configure (must be ≥ presigned URL TTL so active uploads are never killed).

### Option C: No cleanup in Phase 03
- **Pros:** Nothing to build.
- **Cons:** Unbounded storage growth from abandoned 10GB uploads; stale drafts accumulate.

**Recommendation:** **Option B (application sweeper + storage-native expiry as safety net)** — keeps the `videos` table truthful and storage bounded using the queue already in place; the threshold should be configurable via env (e.g., 24h).

**Decision:** B (app sweeper job + storage-native expiry)
**Libraries:** —

**Revisions:**

- 2026-11-07 — Draft expiry spec and sweeper queue (AMB-6, user-decided 2026-11-07): the sweeper runs on its own BullMQ queue, `video-maintenance`, not on `video-processing`. The worker app context (TD-08) registers it with its own processor (`@Processor('video-maintenance', { concurrency: 1 })`) and `defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: { count: 100 } }`; a failed sweep is simply redone at the next tick. On boot the worker calls `upsertJobScheduler('video-sweeper', { every: VIDEO_SWEEPER_INTERVAL_MS }, { name: 'sweep', data: {} })` on `video-maintenance` (idempotent). Each sweep runs two branches: the `processing` reconciliation of TD-13 and the draft expiry below. Draft expiry selects `status = 'draft' AND created_at < now() - VIDEO_UPLOAD_EXPIRE_AFTER_MS` (default 24 h, the same as the storage-native `stale_uploads_expiry` backstop and far above the 1 h part-URL TTL). For each row: (1) `AbortMultipartUpload` with the stored `upload_id` (`NoSuchUpload` tolerated); (2) `DeleteObject` on `videos/{id}/original` (idempotent; the object can exist after the TD-03 AMB-7 crash window); (3) guarded `UPDATE videos SET status = 'failed', failure_reason = 'UPLOAD_EXPIRED', upload_id = NULL WHERE id = :id AND status = 'draft'`. Any other storage error skips that row (logged) until the next tick. Env vars, validated in the Joi schema with these defaults: `VIDEO_SWEEPER_INTERVAL_MS` = 900000 (15 min), `VIDEO_PROCESSING_STUCK_AFTER_MS` = 1800000 (30 min), `VIDEO_UPLOAD_EXPIRE_AFTER_MS` = 86400000 (24 h). Rationale: validation AMB-6. A dedicated queue keeps sweeps from waiting behind CPU-bound video jobs on the concurrency-1 processor, and keeps the `video-processing` retry options and the TD-12 `failed` handler away from sweep jobs.

---

## TD-05: Object Storage Layout (Buckets and Keys)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage technology is given (S3/MinIO); what is open is how objects are organized. Keys are persisted in the `videos` row (original file key, thumbnail key) and used by API, worker and Compose bootstrap, so the convention is cross-component.

**Options:**

### Option A: Single private bucket, prefixes per video id
- One bucket (e.g., `streamtube-videos`, name via env) with `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. All access through presigned URLs.
- **Pros:** One bucket to create/configure (CORS, lifecycle). Keys derived from the immutable UUID, never from user input or slug. Deleting a video = deleting one prefix.
- **Cons:** Thumbnails also need presigned URLs (or a later public-read policy on the `thumbnail` prefix) when listings arrive (Phase 07).

### Option B: Two buckets — private videos, public-read thumbnails
- `streamtube-videos` (private) and `streamtube-thumbnails` (anonymous read) with the same `{videoId}` key scheme.
- **Pros:** Thumbnails can be served by plain URL/CDN without signing. Lifecycle rules (abort incomplete uploads) apply only to the videos bucket.
- **Cons:** Two buckets to bootstrap and configure. Public bucket decided before any listing/visibility rules exist (Phase 04 unlisted videos would still leak thumbnails by URL guessing — mitigated only by random ids).

### Option C: Keys grouped by channel
- `channels/{channelId}/videos/{videoId}/…` in one bucket.
- **Pros:** Per-channel usage accounting by prefix.
- **Cons:** Moving a video between channels (not planned) would require copies; channel id adds no access-control value since all access is presigned.

**Recommendation:** **Option A (single private bucket, `videos/{videoId}/…`)** — the simplest layout that satisfies Phase 03; serving thumbnails publicly is a listing concern for later phases and can be added as a prefix policy without moving objects. Original file extension/content-type is preserved as object metadata, not in the key.

**Decision:** A (single private bucket, `videos/{videoId}/…`)
**Libraries:** —

---

## TD-06: Presigned URL Endpoint — Internal vs. Public Host

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Inside Docker, the API and worker reach storage at `http://minio:9000` (Compose service name — root `CLAUDE.md` Docker Networking rule). A SigV4 presigned URL embeds and signs the host, so a URL signed for `minio:9000` is unreachable from the user's browser on the host (`localhost:9000`), and simply rewriting the host breaks the signature. The same issue applies in production when the internal endpoint differs from the public/CDN one. Cross-layer because the frontend/clients consume those URLs directly.

**Options:**

### Option A: Two endpoints — internal for server operations, public for signing
- Env keys `S3_ENDPOINT` (internal, e.g., `http://minio:9000`) and `S3_PUBLIC_ENDPOINT` (e.g., `http://localhost:9000`); a dedicated `S3Client` configured with the public endpoint is used only by the presigner (signing is offline, no connection needed), the internal client for Create/Complete/Head/Get/Put. `forcePathStyle: true` for MinIO.
- **Pros:** Correct signatures for whoever consumes the URL; no network hacks; maps 1:1 to production (internal VPC endpoint vs public S3/CDN hostname). In-container tests can set the public endpoint to the internal one.
- **Cons:** Two client instances and two env keys to keep consistent; easy to use the wrong client by mistake (encapsulate in one storage service).

### Option B: Single hostname reachable from host and containers
- Use one endpoint for everything, made resolvable on both sides (e.g., `host.docker.internal:9000` with `extra_hosts: host-gateway`, or MinIO `MINIO_SERVER_URL` + a host-file alias).
- **Pros:** One client, one env key.
- **Cons:** Depends on Docker Desktop/OS-specific resolution and host-file edits; container→host→container hairpin traffic for every server-side operation; fragile in CI.

### Option C: Never hand storage URLs to clients — proxy through the API
- **Pros:** Storage stays fully internal.
- **Cons:** Puts all upload/stream bytes back on the API — contradicts TD-02 and the "sem travar" requirement.

**Recommendation:** **Option A (internal endpoint for operations, public endpoint for presigning)** — the standard fix for SigV4 host binding that works the same in Docker and in production without host hacks; wrap both clients behind a single storage service so callers never choose.

**Decision:** A (internal endpoint for operations, public endpoint for signing)
**Libraries:** `@aws-sdk/client-s3@^3.1161.0`, `@aws-sdk/s3-request-presigner@^3.1161.0`

**Revisions:**

- 2026-11-04 — Testing override (IC-1, user-decided): inside containers (integration/e2e suites in `nestjs-api`, and the `video-worker`), presigned URLs that the container itself consumes are signed with the internal endpoint. The test env sets `S3_PUBLIC_ENDPOINT` equal to `S3_ENDPOINT` (`http://minio:9000`), so e2e tests can PUT presigned parts and follow the stream/download 302 from inside the container. The worker always signs its ffprobe/ffmpeg GET URLs with the internal client. Rationale: a SigV4 presigned URL binds the host, so a URL signed for `localhost:9000` is unreachable from inside a container.

---

## TD-07: MinIO Image Source for Local Docker Compose

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** MinIO is the given local storage, but its distribution changed: MinIO Inc. stopped publishing community Docker images in Oct 2025 and archived the community repository in Feb 2026. Verified on 2026-10-21 with `docker manifest inspect`: `minio/minio:latest`, `minio/minio:RELEASE.2025-09-07T16-13-09Z` and `minio/mc:latest` → access denied; `quay.io/minio/minio:latest` → no manifest; `bitnami/minio:latest` → no manifest. The Compose file needs a pullable, maintained image.

**Options:**

### Option A: `pgsty/silo` (community fork of MinIO by Pigsty)
- AGPL-3.0 fork of the MinIO server, multi-arch, latest release 2026-10-18; preserves S3 API, storage format and `MINIO_*` env vars, same `server /data --console-address ":9001"` command; restores the web console. Companion `pgsty/mc` client image for bucket bootstrap. (`pgsty/minio` tag line also exists, last updated 2026-08-04.)
- **Pros:** Drop-in for the "MinIO" that the project plan names; actively released; console available for debugging.
- **Cons:** Community-maintained, "best effort" upstream compatibility; binary is named `silo` (healthcheck/command must use it).

### Option B: `cgr.dev/chainguard/minio:latest`
- Chainguard-built MinIO image (free tier exposes `:latest` only).
- **Pros:** Hardened, minimal image from a known vendor.
- **Cons:** Free tier cannot pin versions (`latest` only) — non-reproducible dev environment; no shell utilities for healthchecks.

### Option C: Build MinIO from source in a local Dockerfile
- **Pros:** Exact upstream code, pinned commit.
- **Cons:** Slow first build (Go toolchain), project maintains a build recipe for an archived upstream; no security fixes after archival.

**Recommendation:** **Option A (`pgsty/silo`, pinned `RELEASE.*` tag)** — a pullable, pinned, maintained drop-in that keeps the "MinIO locally" premise and its env/command conventions; since all code talks S3 via the AWS SDK, swapping the image later costs only a Compose change. Bucket creation can be a one-shot `pgsty/mc` init service or an idempotent `CreateBucket` at app startup (implementation detail for the plan).

**Decision:** A (`pgsty/silo`, pinned release tag)
**Libraries:** `pgsty/silo:RELEASE.2026-10-26T00-00-00Z`, `pgsty/mc:RELEASE.2026-10-26T00-00-00Z` (Docker images)

**Revisions:**

- 2026-11-04 — Testing override (IC-1, user-decided): storage-dependent services, the worker and e2e tests run against this real Silo Compose service via `S3_ENDPOINT=http://minio:9000` (the Compose service name). No local-filesystem storage adapter is built: for this phase this overrides `testing-guide-nestjs-project` `references/external-systems.md` ("use the local filesystem adapter"). There are no `localhost` defaults. The bucket is created idempotently before use (init service or startup `CreateBucket`), and tests isolate by unique `videos/{videoId}/` keys. Image pin refreshed to the latest Silo/mc release available on 2026-11-04 (`RELEASE.2026-10-26T00-00-00Z`). Rationale: a filesystem adapter cannot exercise presigned multipart, `ListParts`, `HeadObject`, endpoint signing or the presigned GET that ffmpeg reads (TD-02/06/09/11), so tests would not cover the contracts the phase delivers.

---

## TD-08: Video Worker Runtime Topology

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The C4 diagram has a separate "Video Worker (FFmpeg)" container. FFmpeg work is CPU/IO heavy and must not compete with API request handling. The worker needs the `videos` entity, DB config, storage service and queue config that the API also uses. Depends on TD-01.

**Options:**

### Option A: Same codebase, separate entrypoint and Compose service
- `nestjs-project/src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server); `WorkerModule` imports shared config/TypeORM/storage/video modules plus the `@Processor`. New Compose service `video-worker` from the same project with its own Dockerfile (Node + ffmpeg); the API image does not run processors.
- **Pros:** Reuses entities, config schema, storage service and tests — no duplication; one lint/tsc/test pipeline. Process isolation and independent scaling (`docker compose up --scale video-worker=N`). Matches the C4 container split.
- **Cons:** Two entrypoints in one package; module wiring must keep API-only providers (controllers, throttler, mailer) out of the worker context.

### Option B: Separate subproject (`video-worker/` with its own package.json)
- **Pros:** Hard isolation of dependencies (ffmpeg tooling never near the API).
- **Cons:** Duplicates entity/config/storage code or forces a shared package/monorepo tooling (not decided anywhere); second test/lint/tsc setup.

### Option C: Processor inside the API process (or BullMQ sandboxed child process)
- **Pros:** No new container.
- **Cons:** FFmpeg load competes with API requests ("sem impacto na performance"); diverges from the C4 diagram; sandboxed processors lose Nest DI (Nest docs).

**Recommendation:** **Option A (same codebase, separate entrypoint and `video-worker` Compose service)** — gives process/container isolation required by the architecture while reusing the existing entities, config and storage code with a single quality pipeline. Worker concurrency starts at 1 (configurable via env) since each job is CPU-bound.

**Decision:** A (same codebase, separate entrypoint + `video-worker` service)
**Libraries:** —

---

## TD-09: FFmpeg Integration — Installation, Invocation and Media Access

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration/metadata (ffprobe) and produce a thumbnail (ffmpeg) for files up to 10GB. Three sub-choices are coupled: how binaries get into the image, how Node calls them, and how the worker reads a 10GB object. Note: `fluent-ffmpeg` is marked on npm as "Package no longer supported" (deprecated). Base image is Debian 12 bookworm (`node:25.6.0-slim`), whose `ffmpeg` package is 5.1.x. Depends on TD-08.

**Options:**

### Option A: Debian `ffmpeg` via apt + `child_process.execFile` + read via presigned GET URL
- Worker Dockerfile adds `apt-get install -y --no-install-recommends ffmpeg`. A small wrapper calls `ffprobe -v error -print_format json -show_format -show_streams <url>` and `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=… thumbnail.jpg` using an internal presigned GET URL; FFmpeg's HTTP protocol seeks with Range requests, so only the needed bytes are fetched. Thumbnail is uploaded with `PutObject`.
- **Pros:** No 10GB temp copy on worker disk; no extra npm dependency; distro-maintained binaries; JSON output parsed into typed metadata. Thumbnail at a deterministic frame (e.g., `min(1s, duration/2)`).
- **Cons:** Performance depends on storage network latency for files whose `moov` atom is at the end (more range requests). FFmpeg 5.1 (older but sufficient for probe/frame grab).

### Option B: Same as A but download the object to a temp volume first
- **Pros:** Local-disk speed for ffprobe/ffmpeg; immune to HTTP seek quirks.
- **Cons:** Needs up to 10GB free scratch space per concurrent job and a full 10GB transfer before any work; cleanup of temp files on failure.

### Option C: npm-bundled static binaries (`ffmpeg-static` / `@ffprobe-installer/ffprobe`) and/or a wrapper lib
- **Pros:** Version pinned through package.json, newer FFmpeg builds.
- **Cons:** Platform-specific binary downloads at install time (bind-mounted `node_modules` shared between host/container architectures is fragile); wrapper libs like `fluent-ffmpeg` are deprecated.

**Recommendation:** **Option A (apt ffmpeg + `execFile` wrapper + presigned GET input)** — avoids a 10GB local copy and any deprecated wrapper, keeps the worker image simple; if HTTP seeking proves slow or flaky in tests, Option B is a contained fallback inside the same wrapper. ffprobe failure (non-video file) is a non-retryable error (TD-12).

**Decision:** A (apt ffmpeg + `execFile` wrapper + presigned GET input)
**Libraries:** `ffmpeg` / `ffprobe` 5.1.x (Debian 12 bookworm apt package `ffmpeg`, `7:5.1.9-0+deb12u1` on 2026-11-04)

**Revisions:**

- 2026-11-04 — _(proposed by plan-resolve — confirmed by user 2026-11-04)_ Persisted metadata (AMB-2). Columns on `videos` set at upload start: `original_filename varchar(255) NOT NULL` (download `Content-Disposition`, TD-11), `content_type varchar(127) NOT NULL` (declared `video/*`), and `size_bytes bigint NOT NULL` (declared, re-verified with `HeadObject` at completion; mapped to `number` via a column transformer since ≤ 10 GiB < 2^53). Columns set by the worker on `processing → ready` (nullable until then): `duration_ms integer` (`round(format.duration × 1000)` from ffprobe), `width integer` and `height integer` (coded dimensions of the first `codec_type = video` stream; rotation side-data ignored in Phase 03), and `video_codec varchar(32)` (that stream's `codec_name`). Not persisted: bitrate, frame rate, audio streams, container `format_name` and the raw ffprobe JSON (no Phase 03 consumer). Invalid media → `UnrecoverableError` with reason `INVALID_MEDIA`. That covers ffprobe exiting non-zero or with unparsable JSON, no video stream, or a missing/non-positive duration. Rationale: validation AMB-2. This is the minimal set that satisfies "extração de duração e metadados" and gives later phases (player, listings) dimensions and codec without a new migration.
- 2026-11-04 — _(proposed by plan-resolve — confirmed by user 2026-11-04)_ Thumbnail parameters (AMB-3). Frame offset `t = min(1 s, duration / 2)`, using input seeking (`-ss t` before `-i`) so only nearby bytes are fetched over HTTP. Command: `ffmpeg -v error -ss <t> -i <internal presigned GET> -frames:v 1 -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2" -q:v 3 -f mjpeg pipe:1`. That is a JPEG that fits inside 1280×720, keeps the aspect ratio, never upscales and has even dimensions; the filter options were verified on the bookworm 5.1.9 binary. stdout is collected via `execFile` with `maxBuffer` 10 MiB and uploaded with `PutObject` to `videos/{videoId}/thumbnail.jpg` (`ContentType: image/jpeg`); the key goes in `thumbnail_key varchar(255)`. Fallback: if no frame comes back at `t > 0`, retry once at `t = 0` within the same attempt. If that also yields nothing → `UnrecoverableError` with reason `THUMBNAIL_FAILED`, and the whole job fails: a `ready` video always has a thumbnail. Transient errors (storage/network, `execFile` timeout of 120 s per ffprobe/ffmpeg call) are thrown normally and retried per TD-12. Rationale: validation AMB-3. The capability requires a thumbnail, and a single `ready` invariant (metadata + thumbnail present) is simpler for later consumers than a partially processed `ready`.
- 2026-11-07 — Transient vs. permanent failure classification (AMB-10, user-decided 2026-11-07): this refines the "ffprobe exiting non-zero → `INVALID_MEDIA`" rule (AMB-2 revision) and the "no frame → `THUMBNAIL_FAILED`" rule (AMB-3 revision). (1) Before ffprobe, the worker runs `HeadObject` on `videos/{videoId}/original` with the internal client. `NotFound` → `UnrecoverableError` with reason `SOURCE_MISSING`: the object was verified at completion, so its absence is permanent and a retry cannot help. Any other `HeadObject` error (network, 5xx, timeout) is thrown normally and retried per TD-12. (2) The internal presigned GET for ffprobe/ffmpeg is signed fresh at the start of each attempt (TTL 15 min, internal client). (3) An `execFile` timeout (120 s) is transient. On a non-zero exit, stderr is matched case-insensitively against the transient list below. A match → a normal `Error`, retried; once the 3 attempts are used up, the TD-12 handler writes `PROCESSING_FAILED`. No match → `UnrecoverableError` with `INVALID_MEDIA` (ffprobe). For the thumbnail, no match → the t = 0 fallback, then `THUMBNAIL_FAILED`. A transient match at t > 0 is thrown at once, without the t = 0 fallback. Unchanged: ffprobe exit 0 with unparsable JSON, no video stream or a missing/non-positive duration → `INVALID_MEDIA`; ffmpeg exit 0 with empty stdout → fallback, then `THUMBNAIL_FAILED`. Transient stderr patterns (FFmpeg HTTP/TCP messages; keep them in one exported constant): `Connection refused`, `Connection reset`, `timed out` (covers `Connection timed out`), `Server returned 5` (any 5XX), `Server returned 403` (expired/invalid signature, re-signed on retry), `Input/output error`, `I/O error`, `Failed to resolve hostname`. Rationale: validation AMB-10. ffprobe/ffmpeg read the input over HTTP, so without this a storage outage would be recorded as a permanently invalid file.

---

## TD-10: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique public identifier for its URL (`docs/project-plan.md` § Pontos de Atenção — "URL curta e única que nunca conflite"). It is generated at pre-registration (TD-03), stored with a unique constraint, and used by stream/download routes now and by watch pages later. Note: `nanoid@6.0.2` is ESM-only and declares `engines.node: ^22 || ^24 || >=26`, excluding the project's Node 25 image.

**Options:**

### Option A: Random 64-bit id, base64url (11 chars), unique index + retry
- `crypto.randomBytes(8).toString('base64url')` → 11 URL-safe chars (YouTube-style), column `slug varchar(11) unique`; on unique-violation insert, regenerate and retry (bounded).
- **Pros:** No dependency; unguessable (good for future unlisted videos, Phase 04); collision probability negligible and still guaranteed safe by the DB constraint. Decoupled from the UUID PK.
- **Cons:** Ids contain `-`/`_` and mixed case (fine for URLs, less friendly to dictate).

### Option B: Expose the UUID primary key
- **Pros:** Already unique; nothing to generate.
- **Cons:** 36 chars — not "curta"; leaks internal id into public URLs.

### Option C: Encoded sequential id (Sqids/Hashids over a serial column)
- **Pros:** Short and collision-free by construction.
- **Cons:** Requires a serial column alongside the UUID PK and a library; ids are reversible (reveal ordering/volume), undesirable for unlisted links.

**Recommendation:** **Option A (random 11-char base64url with unique constraint and retry)** — short, unguessable, dependency-free, and the DB constraint makes "sem conflito" a hard guarantee rather than a probability.

**Decision:** A (random 11-char base64url + unique constraint + retry)
**Libraries:** —

---

## TD-11: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, which requires HTTP Range requests answered with `206 Partial Content`; download must deliver the file with `Content-Disposition: attachment`. The C4 diagram shows the frontend streaming from Object Storage directly. Depends on TD-06 (public endpoint) and TD-14 (access policy).

**Options:**

### Option A: API resolves and redirects to a short-lived presigned GET (302)
- `GET /videos/:slug/stream` → `302` to a presigned `GetObject` URL (e.g., TTL ~1h); `GET /videos/:slug/download` → `302` to a presigned URL with `ResponseContentDisposition=attachment; filename="<title>.<ext>"` and `ResponseContentType`. S3/MinIO answer Range/206 natively.
- **Pros:** Video bytes never pass through the API (consistent with TD-02); Range/206, `Accept-Ranges`, `Content-Length` handled by storage; works directly as `<video src>`. Download filename controlled by signed response overrides.
- **Cons:** URL expiry must outlive a viewing session or the player must re-request; the storage host must be reachable/CORS-enabled for clients.

### Option B: API proxies bytes with Range support
- API parses `Range`, calls `GetObject` with that range and pipes the stream back as `206` with `Content-Range`.
- **Pros:** Storage stays private; full control over headers and access checks on every chunk.
- **Cons:** Every byte of every view crosses the API — the load profile TD-02 avoided for uploads; must implement Range parsing/edge cases (multi-range, `416`). Diverges from the C4 "frontend streams from storage".

### Option C: Public-read bucket with direct object URLs
- **Pros:** Simplest; CDN-friendly.
- **Cons:** No access control at all (drafts/unlisted/failed videos readable by key); conflicts with TD-05 private bucket.

**Recommendation:** **Option A (302 redirect to short-lived presigned GET, with `ResponseContentDisposition` for download)** — delegates Range/206 to the storage that already implements it, keeps the API out of the data path, and matches the architecture diagram; only `ready` videos are redirectable (TD-12).

**Decision:** A (302 to short-lived presigned GET; `ResponseContentDisposition` for download)
**Libraries:** `@aws-sdk/s3-request-presigner@^3.1161.0`

**Revisions:**

- 2026-11-07 — Stream/download contract (AMB-8, user-decided 2026-11-07): both routes are `@Public()` (TD-14) and take the TD-10 slug. (1) `GET /videos/:slug/stream` → `302 Found` with `Location` = a presigned `GetObject` URL for `videos/{id}/original`, signed with the public client (TD-06) and `expiresIn: 3600` (1 h, the same TTL as the part URLs; long enough for a typical viewing session, and the player re-requests the route when it expires). No response overrides: the object already carries the declared `content_type` (set by `CreateMultipartUpload`), and storage answers `Range` with `206`. (2) `GET /videos/:slug/download` → `302` to the same kind of URL (TTL 3600 s) with `ResponseContentDisposition = attachment; filename="<ascii>"; filename*=UTF-8''<encoded>` (RFC 6266 / RFC 5987). The filename is the sanitized `title` plus the original extension. The extension is the last `.ext` of `original_filename` (TD-09), lower-cased, kept only if it matches `^[a-z0-9]{1,10}$` and omitted otherwise. To sanitize the title: remove control characters and `/ \ : * ? " < > |`, collapse whitespace, trim spaces and trailing dots, and use `video` if nothing is left. `<encoded>` is that name percent-encoded (`encodeURIComponent`, plus `'`, `(`, `)`, `*`); `<ascii>` is the same name with each non-ASCII character replaced by `_`. (3) Both routes answer `404 VIDEO_NOT_FOUND` for an unknown slug **and** for a video that is not `ready` (`draft`, `processing`, `failed`), the same code for both, so the state of a non-public video is not revealed. (4) The 302 response carries `Cache-Control: no-store`, so a cached redirect never outlives its signed URL. Rationale: validation AMB-8. Cross-layer TDs feed `### API Contracts`. The 1 h TTL is a user decision; library-refs.md was updated from 300 s.

---

## TD-12: Video Status Lifecycle and Processing Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The exercise requires the lifecycle "rascunho → processando → pronto/erro" reflected in the DB. Phase 04 will later introduce a separate draft→publication flow and visibility; this TD must not pre-empt it. Failures can be transient (storage/DB hiccup, worker crash) or permanent (file is not a valid video). Depends on TD-01, TD-09.

**Options:**

### Option A: Single `status` enum `draft → processing → ready | failed`, retries then terminal `failed`
- `draft` = pre-registered, upload not yet confirmed; API moves `draft → processing` on successful completion (TD-03) and enqueues; worker moves `processing → ready` (duration, metadata, thumbnail key persisted) or `processing → failed` with `failure_reason`. BullMQ `attempts: 3` with exponential backoff for transient errors; permanent errors (ffprobe cannot parse) throw BullMQ `UnrecoverableError` to skip retries. Worker transitions are guarded (`UPDATE … WHERE status = 'processing'`) so redelivery is idempotent. No reprocess endpoint in Phase 03 (no capability requires it).
- **Pros:** Matches the exercise wording exactly; one column, easy to query and test; idempotent worker. Phase 04 adds publication/visibility as separate columns without touching this enum.
- **Cons:** "draft" here means "upload pending", while Phase 04 "rascunho" means "unpublished" — must be documented to avoid confusion. A `failed` video can only be replaced by a new upload.

### Option B: Same lifecycle plus owner-triggered reprocess
- Adds `POST /videos/:id/reprocess` moving `failed → processing` and re-enqueuing.
- **Pros:** Recovers from transient failures that exhausted retries without re-uploading 10GB.
- **Cons:** New endpoint and authorization rule not traced to a Phase 03 capability; most permanent failures will fail again.

### Option C: Separate columns now — `upload_status` and `processing_status`
- **Pros:** Each concern has its own state machine; no "draft" ambiguity.
- **Cons:** More states/combinations to validate; deviates from the exercise's single lifecycle; over-designs ahead of Phase 04.

**Recommendation:** **Option A (single `draft → processing → ready | failed` enum, 3 attempts with exponential backoff, `UnrecoverableError` for invalid media, terminal `failed` with reason)** — the minimal lifecycle that satisfies the acceptance criterion and stays idempotent under redelivery; reprocess (B) can be added later via `/decide` if real transient failures show up. Failed BullMQ jobs are retained (`removeOnFail` with a count) for inspection.

**Decision:** A (`draft → processing → ready | failed`, 3 attempts + backoff, terminal failed)
**Libraries:** —

**Revisions:**

- 2026-11-04 — Status semantics (AMB-4, user-decided): `status` is the processing lifecycle only. `draft` = pre-registered, upload not yet completed. The Phase 03 "rascunho" capability is satisfied by the pre-registered row. The enum keeps `draft | processing | ready | failed` because the exercise's acceptance criterion literally names "rascunho → processando → pronto/erro". Phase 04 adds an independent publication/visibility field and does not reuse or rename this enum. `failure_reason varchar(32) NULL` holds one of `UPLOAD_EXPIRED` (TD-04), `UPLOAD_ABORTED` and `UPLOAD_SIZE_MISMATCH` (TD-03), `INVALID_MEDIA` and `THUMBNAIL_FAILED` (TD-09), and `PROCESSING_FAILED` (retries exhausted / stalled / sweeper). It is typed as a TS union, not a PG enum, so codes can be added without an enum migration. Rationale: validation AMB-4. This avoids overloading `draft` with Phase 04's "unpublished" meaning.
- 2026-11-04 — _(proposed by plan-resolve — confirmed by user 2026-11-04)_ Terminal failure write (AMB-1). The terminal `processing → failed` write lives in the processor's `@OnWorkerEvent('failed')` handler (`@nestjs/bullmq`), not in `process()`. It acts when `job` is defined and either the error is an `UnrecoverableError` or `job.attemptsMade >= job.opts.attempts`. It runs a guarded `UPDATE videos SET status='failed', failure_reason=<code> WHERE id = job.data.videoId AND status='processing'`. `<code>` is the processing error's domain code (`INVALID_MEDIA` / `THUMBNAIL_FAILED`) or `PROCESSING_FAILED` otherwise. The handler never throws; it logs its own errors. Job options: `attempts: 3`, `backoff: { type: 'exponential', delay: 10000 }`, `removeOnComplete: true`, `removeOnFail: { count: 1000 }`. The `failed` event may carry `job === undefined`, as with jobs failed for exceeding `maxStalledCount` (default 1); those are reconciled by the TD-13 sweeper. Rationale: validation AMB-1. One place covers both thrown-error paths; the sweeper covers the cases the event cannot (BullMQ docs v6.5.3: Workers/events, Stalled jobs, Stop retrying jobs).
- 2026-11-07 — Failed-handler guard and failure codes (AMB-6, AMB-10, user-decided 2026-11-07): the `@OnWorkerEvent('failed')` handler exists only on the `video-processing` processor. Sweep jobs run on the separate `video-maintenance` queue (TD-04 revision) and never reach it. As defence in depth, the handler returns without writing when `job` is `undefined` or `job.data.videoId` is not a non-empty string: TypeORM drops `undefined` criteria from `where`, so an unguarded `update({ id: undefined, status: 'processing' }, …)` would fail every `processing` video. The `failure_reason` codes are now `UPLOAD_EXPIRED` (TD-04), `UPLOAD_ABORTED` and `UPLOAD_SIZE_MISMATCH` (TD-03), `INVALID_MEDIA`, `THUMBNAIL_FAILED` and `SOURCE_MISSING` (TD-09), and `PROCESSING_FAILED` (retries exhausted, including transient storage/ffprobe/ffmpeg errors; stalled jobs; sweeper). Rationale: validation AMB-6 and AMB-10.

---

## TD-13: Consistency Between Upload Completion and Job Enqueue

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** With TD-01 Option A, "mark video `processing`" (PostgreSQL) and "enqueue job" (Redis) are two writes to different systems. If the API crashes between them, the video is stuck in `processing` without a job (or a job runs for a video still in `draft`). Processing must be automatic after upload, so this gap matters. Depends on TD-01 and TD-12.

**Options:**

### Option A: Commit then enqueue with deterministic `jobId`, idempotent completion, sweeper backstop
- Complete endpoint: `CompleteMultipartUpload` → update row to `processing` → `queue.add('process', { videoId }, { jobId: videoId })`. Repeating the complete call for a `processing` video re-adds the same `jobId` (BullMQ ignores duplicates of an existing job). The TD-04 sweeper also re-enqueues `processing` videos with no active job after a threshold.
- **Pros:** No new tables; BullMQ's `jobId` dedupe makes retries safe; the client can simply retry completion on error.
- **Cons:** A tiny window where a stuck video waits for the sweeper; the sweeper must check job existence.

### Option B: Transactional outbox table
- Insert an `outbox` row in the same transaction as the status change; a relay polls the outbox and enqueues to BullMQ, marking rows sent.
- **Pros:** Guaranteed eventual enqueue; general pattern for future events.
- **Cons:** Extra table, relay process and tests for a single job type — heavy for this phase.

### Option C: Enqueue first, worker tolerates `draft`
- **Pros:** Job is never lost.
- **Cons:** Job may run before/without the status change (or for an upload that then fails to complete); worker must handle more states.

**Recommendation:** **Option A (commit, then enqueue with `jobId = videoId`; idempotent completion; sweeper backstop)** — closes the dual-write gap with mechanisms already chosen (BullMQ dedupe + TD-04 scheduler) without introducing an outbox. If pg-boss were chosen in TD-01 instead, the enqueue could share the DB transaction and this TD would collapse.

**Decision:** A (commit then enqueue with `jobId = videoId`, idempotent completion, sweeper)
**Libraries:** —

**Revisions:**

- 2026-11-04 — _(proposed by plan-resolve — confirmed by user 2026-11-04)_ Sweeper reconciliation for `processing` (AMB-1). The TD-04 Job Scheduler (`upsertJobScheduler('video-sweeper', { every: VIDEO_SWEEPER_INTERVAL_MS })`, default 15 min) also scans videos in `processing` whose `processing_started_at` (new `timestamptz NULL` column, set on `draft → processing`) is older than `VIDEO_PROCESSING_STUCK_AFTER_MS` (default 30 min). For each, it calls `queue.getJob(videoId)` and `job.getState()`. (a) Job missing / state `unknown` (the dual-write gap or an evicted job): re-add with `jobId = videoId`. (b) State `failed`: write terminal `failed`/`PROCESSING_FAILED` with the same guarded UPDATE. There is no remove-and-re-add, consistent with "no reprocess" in TD-12, and the retained failed job is why a plain re-add would be a silent no-op. (c) State `completed` while the row is still `processing` (anomaly): `job.remove()` then re-add. (d) `waiting` / `delayed` / `prioritized` / `active` / `waiting-children`: leave it alone. Known edge: if `removeOnFail` evicted a failed job before the sweeper saw it, the video is re-enqueued once more (bounded by 3 attempts). Rationale: validation AMB-1. BullMQ ignores `add` for an existing `jobId`, including retained failed/completed jobs, so the sweeper must branch on job state.
- 2026-11-07 — Sweeper queue (AMB-6, user-decided 2026-11-07): the `video-sweeper` Job Scheduler lives on the dedicated `video-maintenance` queue (TD-04 revision), not on `video-processing`. The maintenance processor injects the processing queue (`@InjectQueue('video-processing')`) to run the `getJob` / `getState` / re-add branches above, so the worker app context registers both queues (`BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: <TD-12 options> }, { name: 'video-maintenance', defaultJobOptions: <TD-04 options> })`). The env names are unchanged (`VIDEO_SWEEPER_INTERVAL_MS`, `VIDEO_PROCESSING_STUCK_AFTER_MS`); the same sweep also runs the TD-04 draft expiry (`VIDEO_UPLOAD_EXPIRE_AFTER_MS`). Rationale: validation AMB-6.

---

## TD-14: Access Policy for Streaming and Download in Phase 03

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Phase 03 ships streaming and download, but the publication flow (draft → published) and visibility (public/unlisted) only arrive in Phase 04, and anonymous viewing is formalized in Phase 05. Someone must be authorized to stream/download in Phase 03. The choice affects whether the stream/download routes are `@Public()` and whether a future `<video src>` can point at them without an `Authorization` header.

**Options:**

### Option A: Anyone with the unique URL, only for `ready` videos
- Stream/download routes are `@Public()`; non-`ready` videos return a domain error (`404`/`409`). Access is effectively "unlisted by unguessable slug" (TD-10) until Phase 04 adds publication/visibility checks.
- **Pros:** Aligns with the project premise that anonymous users watch freely; `<video src>` works without auth plumbing; no listing exists in Phase 03, so nothing is discoverable.
- **Cons:** Unpublished (Phase 04 sense) videos are reachable by link until Phase 04 tightens the rule — a behaviour change later.

### Option B: Owner-only (authenticated, channel owner) until Phase 04/05
- **Pros:** Most conservative; nothing reachable before publication exists.
- **Cons:** Player cannot use a plain URL — requires the BFF to fetch the redirect with the token; Phase 05 must relax it (also a behaviour change).

**Recommendation:** **Option A (public by unique slug, `ready` only)** — consistent with the platform's anonymous-viewing premise and with TD-10's unguessable ids, and keeps the stream/download contract stable for Phase 05; Phase 04 then adds the publication/visibility gate. Upload and completion endpoints remain authenticated and owner-scoped.

**Decision:** A (public by unique slug, `ready` only)
**Libraries:** —

**Revisions:**

- 2026-11-04 — Phase 04 boundary (AMB-4, user-decided): the Phase 03 gate for public stream/download is `status = 'ready'` only. Phase 04 adds the separate publication/visibility field (TD-12 revision) and tightens these same routes to also require publication. The route shapes and the 302 contract (TD-11) do not change. Rationale: validation AMB-4. It makes the planned behaviour change explicit so Phase 04 plans it rather than discovers it.
- 2026-11-07 — Non-`ready` response (AMB-8, user-decided 2026-11-07): Option A's "`404`/`409`" becomes `404 VIDEO_NOT_FOUND`, the same as an unknown slug (TD-11 revision). Rationale: validation AMB-8. A public, unauthenticated route should not reveal whether a non-public video exists or what state it is in.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology for Video Processing Jobs | A (BullMQ on Redis via `@nestjs/bullmq`) | A (BullMQ on Redis via `@nestjs/bullmq`) |
| TD-02 | Cross-layer | Upload Protocol for Files up to 10GB | A (S3 multipart with presigned part URLs, direct to storage) | A (S3 multipart with presigned part URLs, direct to storage) |
| TD-03 | Cross-layer | Upload Session API Shape and Draft Pre-registration | A (single start call creates draft + multipart session) | A (single start call creates draft + multipart session) |
| TD-04 | Backend | Abandoned / Incomplete Upload Cleanup | B (app sweeper job + storage-native expiry) | B (app sweeper job + storage-native expiry) |
| TD-05 | Backend | Object Storage Layout (Buckets and Keys) | A (single private bucket, `videos/{videoId}/…`) | A (single private bucket, `videos/{videoId}/…`) |
| TD-06 | Cross-layer | Presigned URL Endpoint — Internal vs. Public Host | A (internal endpoint for operations, public endpoint for signing) | A (internal endpoint for operations, public endpoint for signing) |
| TD-07 | Repo-wide | MinIO Image Source for Local Docker Compose | A (`pgsty/silo`, pinned release tag) | A (`pgsty/silo`, pinned release tag) |
| TD-08 | Repo-wide | Video Worker Runtime Topology | A (same codebase, separate entrypoint + `video-worker` service) | A (same codebase, separate entrypoint + `video-worker` service) |
| TD-09 | Backend | FFmpeg Integration — Installation, Invocation and Media Access | A (apt ffmpeg + `execFile` wrapper + presigned GET input) | A (apt ffmpeg + `execFile` wrapper + presigned GET input) |
| TD-10 | Cross-layer | Unique Video URL Identifier | A (random 11-char base64url + unique constraint + retry) | A (random 11-char base64url + unique constraint + retry) |
| TD-11 | Cross-layer | Streaming and Download Delivery | A (302 to short-lived presigned GET; `ResponseContentDisposition` for download) | A (302 to short-lived presigned GET; `ResponseContentDisposition` for download) |
| TD-12 | Backend | Video Status Lifecycle and Processing Failure Handling | A (`draft → processing → ready \| failed`, 3 attempts + backoff, terminal failed) | A (`draft → processing → ready \| failed`, 3 attempts + backoff, terminal failed) |
| TD-13 | Backend | Consistency Between Upload Completion and Job Enqueue | A (commit then enqueue with `jobId = videoId`, idempotent completion, sweeper) | A (commit then enqueue with `jobId = videoId`, idempotent completion, sweeper) |
| TD-14 | Cross-layer | Access Policy for Streaming and Download in Phase 03 | A (public by unique slug, `ready` only) | A (public by unique slug, `ready` only) |

## Sources

- NestJS — Queues (`@nestjs/bullmq`): https://docs.nestjs.com/techniques/queues
- `@nestjs/bullmq@12.0.0` package (npm) — peer deps and `dist/bull.providers.js` / `dist/bull.explorer.js` constructor calls (inspected 2026-10-21)
- BullMQ — Going to production: https://docs.bullmq.io/guide/going-to-production
- BullMQ — PostgreSQL backend: https://docs.bullmq.io/guide/postgresql ; changelog: https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/changelog.md
- pg-boss: https://github.com/timgit/pg-boss
- AWS S3 multipart upload limits: https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
- MinIO server config (`api stale_uploads_expiry`, `cors_allow_origin`): https://gitea.com/ewcl/minio/src/branch/master/docs/config ; MinIO CE status: https://glukhov.org/data-infrastructure/object-storage/minio-dead/
- Pigsty Silo (MinIO fork): https://github.com/pgsty/minio
- npm registry metadata (2026-10-21): `bullmq@6.4.0`, `@nestjs/bullmq@12.0.0`, `pg-boss@12.38.0`, `@aws-sdk/client-s3@3.1155.0`, `@aws-sdk/s3-request-presigner@3.1155.0`, `nanoid@6.0.2` (engines), `fluent-ffmpeg@2.1.3` (deprecated)
- Docker image availability checked with `docker manifest inspect` (2026-10-21); base image OS checked with `docker run node:25.6.0-slim cat /etc/os-release`
