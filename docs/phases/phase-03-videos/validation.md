---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 6
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-04T14:14:30-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-26T17:14:37-03:00"
issues:
  - id: IC-1
    status: open
    summary: "Testing Requirements allow a storage 'local adapter'; TD-05/06/09/11 need real S3"
  - id: AMB-1
    status: open
    summary: "TD-12/TD-13: retained failed job (jobId=videoId) makes sweeper re-enqueue a no-op"
  - id: AMB-2
    status: open
    summary: "Which metadata the processing step extracts and persists is unspecified"
  - id: AMB-3
    status: open
    summary: "Thumbnail frame choice and output size/format are unspecified"
  - id: AMB-4
    status: open
    summary: "'rascunho' (draft) means upload-pending here vs. unpublished in Phase 04"
  - id: AMB-5
    status: open
    summary: "TD-03 sub-routes and the user-initiated abort outcome are absent from context.md"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `## Testing Requirements` (from `testing-guide-nestjs-project` §3) says *"Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter"*. The guide's `references/external-systems.md` (whose mtime is recorded in context.md's `sources_mtime`) makes this stronger: *"Local filesystem storage in development and tests … In tests, use the local filesystem adapter"*. Its connection examples also default to `localhost` (`REDIS_HOST ?? 'localhost'`). This conflicts with decided TDs that only real S3 semantics can satisfy:
  - phase-03-videos/TD-02: presigned multipart part URLs, `ListParts`, and `HeadObject` before completion.
  - phase-03-videos/TD-06: internal vs. public endpoint signing.
  - phase-03-videos/TD-07: MinIO (`pgsty/silo`) in Compose.
  - phase-03-videos/TD-09: ffprobe/ffmpeg read media from an internal presigned GET URL.
  - phase-03-videos/TD-11: 302 to a presigned GET with `ResponseContentDisposition`.

  A local-filesystem adapter can produce none of these, so the tests would not exercise the contracts the phase delivers. The `localhost` defaults also contradict the root `CLAUDE.md` Docker-networking rule (always use Compose service names). Explicit choice:
  - **(a) — recommended:** add a phase-level testing override, either as a `**Revisions:**` note on TD-05/TD-07 or a testing note carried into context.md. Storage-dependent services and the worker are integration/e2e-tested against the real MinIO (Silo) Compose service via `S3_ENDPOINT` set to the Compose service name. Queue and processor tests run against the real Redis Compose service via `REDIS_HOST` set to the service name. There is no local-filesystem storage adapter and no `localhost` defaults. Presigned URLs used from inside containers are signed with the internal endpoint (TD-06).
  - **(b):** keep a local adapter for unit-level speed and accept that presign, multipart and redirect behaviour is covered only by e2e.

  In either case, updating the testing-guide skill itself is a separate, out-of-scope follow-up.

### Ambiguities

- **AMB-1** — phase-03-videos/TD-12 retains failed jobs (*"`removeOnFail` with a count"*), and phase-03-videos/TD-13 relies on *"`jobId = videoId`"* plus a *"sweeper backstop"* that re-enqueues stuck videos. BullMQ ignores `add` when a job with the same id is still kept in the queue, including failed jobs (bullmq docs, "Job Ids" and "Auto-removal of jobs → idempotence"). Consider a job that ends `failed` without the processor writing the terminal `failed` status. Two examples: a stalled job exceeding `maxStalledCount`, or a worker crash after the last attempt. The video then stays `processing`, and every sweeper re-enqueue is silently dropped as a duplicate. The phase does not say where the terminal `failed` status is persisted (inside the processor vs. a worker `failed` event handler), nor what the sweeper does when a job for that videoId already exists. Explicit choice: append a revision to TD-12/TD-13 that defines both:
  - **(a):** the terminal-failure write lives in the worker `failed` event (covers stalled and exhausted jobs).
  - **(b):** the sweeper inspects `getJob(videoId)` state. If the job is failed or missing, it either marks the video `failed` or removes the job and re-adds it. If the job is active or waiting, it leaves it alone.
- **AMB-2** — Capability *"Processamento automático do vídeo após upload (extração de duração e metadados)"*: phase-03-videos/TD-09 and TD-12 define how ffprobe runs and how failures are handled. They do not say **which metadata** is persisted (e.g., duration only, or also width/height, codec, container/format, bitrate, size), nor the column types and precision (e.g., duration in seconds as numeric vs. integer ms). An implementer would have to ask which fields go into the `videos` table and its migration. Explicit choice: list the persisted metadata fields and their types (append a revision to TD-09 or TD-12).
- **AMB-3** — Capability *"Geração automática de thumbnail a partir de um frame do vídeo"*: phase-03-videos/TD-05 fixes the key (`thumbnail.jpg`) and TD-09 the invocation. Several things are unspecified:
  - which frame is captured: fixed offset, percentage of duration, or a fallback for very short videos;
  - output dimensions or scaling;
  - whether a missing or failed thumbnail fails the whole job or leaves the video `ready` without a thumbnail.

  Explicit choice: fix these parameters (append a revision to TD-09).
- **AMB-4** — The capability *"Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"* is modelled by phase-03-videos/TD-12 as status `draft` = "upload not yet completed" (`draft → processing → ready | failed`). Neighbor Phase 04's scope is *"fluxo de rascunho e publicação"*, where rascunho means "processed but not yet published". phase-03-videos/TD-14 makes every `ready` video publicly streamable by slug, so in Phase 03 a video stops being a "rascunho" and becomes public as soon as processing ends. Phase 04 will need a separate publication/visibility axis. Otherwise the `draft` enum value gets overloaded, or a breaking enum/migration change is needed. Explicit choice:
  - **(a) — recommended:** record (revision on TD-12/TD-14) that `status` is the processing lifecycle only. The Phase 03 "rascunho" capability is met by the pre-registered row. Phase 04 adds an independent publication field and gates TD-14 on it. Keep the `draft` value: the exercise's acceptance criterion names the cycle *"rascunho → processando → pronto/erro"* literally.
  - **(b):** leave it implicit and accept a possible Phase 04 enum/migration change.
- **AMB-5** — phase-03-videos/TD-03's Decisions Detail in context.md covers only the start call (*"Single start call creates draft + multipart session"*). The rest of the upload-session contract is not listed: the part-signing, part-listing (resume, per TD-02 `ListParts`), complete and abort operations, their routes, and their request/response shapes. The outcome of a **user-initiated abort** for the `videos` row is undefined: delete the draft, or mark `failed` with a reason, analogous to TD-04's `UPLOAD_EXPIRED`. Cross-layer TDs feed `### API Contracts` in plan-build, so the contract has to be explicit. Explicit choice: carry the sub-route list and the abort outcome into the TD-03 detail (revision, or a re-extraction if the decisions doc body already states them).

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

_No issues resolved yet._
