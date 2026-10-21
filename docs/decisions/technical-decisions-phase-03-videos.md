---
scope_type: phase
related_phases: [3]
status: pending
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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

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

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology for Video Processing Jobs | A (BullMQ on Redis via `@nestjs/bullmq`) | _[pending]_ |
| TD-02 | Cross-layer | Upload Protocol for Files up to 10GB | A (S3 multipart with presigned part URLs, direct to storage) | _[pending]_ |
| TD-03 | Cross-layer | Upload Session API Shape and Draft Pre-registration | A (single start call creates draft + multipart session) | _[pending]_ |
| TD-04 | Backend | Abandoned / Incomplete Upload Cleanup | B (app sweeper job + storage-native expiry) | _[pending]_ |
| TD-05 | Backend | Object Storage Layout (Buckets and Keys) | A (single private bucket, `videos/{videoId}/…`) | _[pending]_ |
| TD-06 | Cross-layer | Presigned URL Endpoint — Internal vs. Public Host | A (internal endpoint for operations, public endpoint for signing) | _[pending]_ |
| TD-07 | Repo-wide | MinIO Image Source for Local Docker Compose | A (`pgsty/silo`, pinned release tag) | _[pending]_ |
| TD-08 | Repo-wide | Video Worker Runtime Topology | A (same codebase, separate entrypoint + `video-worker` service) | _[pending]_ |
| TD-09 | Backend | FFmpeg Integration — Installation, Invocation and Media Access | A (apt ffmpeg + `execFile` wrapper + presigned GET input) | _[pending]_ |
| TD-10 | Cross-layer | Unique Video URL Identifier | A (random 11-char base64url + unique constraint + retry) | _[pending]_ |
| TD-11 | Cross-layer | Streaming and Download Delivery | A (302 to short-lived presigned GET; `ResponseContentDisposition` for download) | _[pending]_ |
| TD-12 | Backend | Video Status Lifecycle and Processing Failure Handling | A (`draft → processing → ready \| failed`, 3 attempts + backoff, terminal failed) | _[pending]_ |
| TD-13 | Backend | Consistency Between Upload Completion and Job Enqueue | A (commit then enqueue with `jobId = videoId`, idempotent completion, sweeper) | _[pending]_ |
| TD-14 | Cross-layer | Access Policy for Streaming and Download in Phase 03 | A (public by unique slug, `ready` only) | _[pending]_ |

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
