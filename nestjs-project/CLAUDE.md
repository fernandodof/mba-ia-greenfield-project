# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, Redis, object storage) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose ps` shows `minio` as `healthy` and the one-shot `minio-init` as `Exited (0)` (bucket created)

`docker compose up -d` also starts `video-worker` (it belongs to the stack, `restart: unless-stopped`); that is expected and is not "starting the server".

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (container idles on `tail -f /dev/null` until you run a command)
- `video-worker` — video processing worker (`npm run start:worker:dev`), no ports — see "Videos" below
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP `1025`, web UI `8025`
- `redis` — Redis 8 for BullMQ, `--maxmemory-policy noeviction`, no host port
- `minio` — S3-compatible storage (`pgsty/silo`), API `9000`, console `9001`
- `minio-init` — one-shot `mc` job that creates the private bucket (`${S3_BUCKET:-streamtube-videos}`) and exits

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (serial: maxWorkers 1 in test/jest-e2e.json)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config", <setup-test-env>]` — `dotenv/config` loads `.env` inside the Jest process (without it `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to `localhost`, breaking container-to-container DNS). Then `src/test/setup-test-env.ts` sets `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` (tests run inside the container, so presigned URLs must be signed for the internal host) and `QUEUE_PREFIX=bull-test` (keeps test queues away from the Compose `video-worker`, which uses `bull`).
- `transformIgnorePatterns: ["/node_modules/(?!(@nestjs/bullmq|@nestjs/bull-shared)/)"]` — those packages are ESM-only; ts-jest must transform them. Add any future ESM-only test dependency to this pattern.
- `maxWorkers: 1` (e2e only) — e2e suites share the DB and Redis and wipe each other's tables when run in parallel.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

Two processes share the codebase: the API (`src/main.ts` → `AppModule`) and the video worker (`src/worker.ts` → `VideoWorkerModule`, an application context with no HTTP listener). Both use `src/config/config-module.options.ts` and `DatabaseModule`; register new config namespaces in the shared options file.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos (upload, processing, playback)

Design decisions: `docs/decisions/technical-decisions-phase-03-videos.md` (TD-01…TD-14). Full contracts: `docs/phases/phase-03-videos/phase-03-videos.md` → Technical Specifications, and `openapi.json`.

### Environment variables

Validated in `src/config/env.validation.ts`, read through `redis.config.ts`, `storage.config.ts` and `video.config.ts`; dev values in `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | BullMQ connection |
| `QUEUE_PREFIX` | `bull` | BullMQ key prefix (tests force `bull-test`) |
| `S3_ENDPOINT` | required (`http://minio:9000`) | Internal endpoint for every storage operation |
| `S3_PUBLIC_ENDPOINT` | required (`http://localhost:9000`) | Used only to sign URLs for clients outside Docker |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | required (secret ≥ 8 chars) | Storage credentials; Compose also passes them to `minio` / `minio-init` as root user/password |
| `S3_BUCKET` | `streamtube-videos` | Private bucket |
| `VIDEO_WORKER_CONCURRENCY` | `1` | Concurrent `video-processing` jobs per worker |
| `VIDEO_SWEEPER_INTERVAL_MS` | `900000` (15 min) | Sweeper Job Scheduler interval |
| `VIDEO_PROCESSING_STUCK_AFTER_MS` | `1800000` (30 min) | Age after which a `processing` row is reconciled |
| `VIDEO_UPLOAD_EXPIRE_AFTER_MS` | `86400000` (24 h) | Age after which a `draft` upload is expired |

Compose interpolates `${S3_ACCESS_KEY_ID}`, `${S3_SECRET_ACCESS_KEY}` and `${S3_BUCKET:-streamtube-videos}` from `.env`; Joi defaults never reach Compose, so keep the `:-` fallback in `compose.yaml`.

### Upload flow and routes

Clients upload straight to storage with S3 multipart and presigned part URLs: 64 MiB parts, at most 10 GiB per video (160 parts). Fixed limits and URL TTLs live in `src/videos/video.constants.ts`, not env. All routes are in `VideosController` (`@SkipThrottle()`); `:id` routes are owner-only (a non-owner gets `404`) and use `ParseUUIDPipe`.

| Route | Auth | What it does |
|---|---|---|
| `POST /videos` | JWT | Creates a `draft` row with a unique 11-char slug plus a multipart session; returns part size/count |
| `GET /videos/:id` | owner | Status and metadata of the owner's video |
| `POST /videos/:id/upload/parts` | owner | Signs part URLs (1 h TTL) |
| `GET /videos/:id/upload/parts` | owner | Lists uploaded parts (resume) |
| `POST /videos/:id/upload/complete` | owner | Completes the multipart upload, checks the stored size, `draft → processing`, enqueues the job. Idempotent |
| `DELETE /videos/:id/upload` | owner | Aborts the session, deletes the original, `failed`/`UPLOAD_ABORTED` (204) |
| `GET /videos/:slug/stream` · `/download` | `@Public()` | `302` to a 1 h presigned GET (storage serves Range/206); `ready` only, else `404`; download sets `Content-Disposition: attachment` |

### Status lifecycle

`draft → processing → ready | failed`, with `failure_reason` (`varchar(32)`, `src/videos/video.types.ts`):

- from `draft`: `UPLOAD_ABORTED`, `UPLOAD_EXPIRED`, `UPLOAD_SIZE_MISMATCH`
- from `processing`: `INVALID_MEDIA`, `THUMBNAIL_FAILED`, `SOURCE_MISSING`, `PROCESSING_FAILED` (retries exhausted or a stuck row with a failed job)

`VideoLifecycleService` (`src/videos/video-lifecycle.service.ts`, exported by `VideosModule`) is the single home of status writes: each transition is a guarded `UPDATE … WHERE status = :expected` returning `false` when another actor won the race. Add new transitions there, never as ad-hoc repository updates elsewhere. There is no reprocess endpoint: `failed` is terminal.

### Queues (BullMQ on Redis)

Names, payloads and job options are shared in `src/videos/video-queue.constants.ts`; `QueueModule` holds the root connection and prefix.

- **`video-processing`** — registered once in `VideosModule` (the API produces; the worker imports `VideosModule`). `VideoProcessingQueue.enqueue` uses `jobId = videoId`, so re-enqueues dedupe. 3 attempts, exponential backoff (10 s), failed jobs retained (last 1000). Permanent failures throw `VideoProcessingFailure` (extends BullMQ `UnrecoverableError`, carries the `failure_reason`), which skips the remaining attempts. `VideoProcessor.onFailed` writes `failed` on an unrecoverable error or the last attempt.
- **`video-maintenance`** — worker-only. `VideoSweeperScheduler` upserts the `video-sweeper` Job Scheduler at every worker boot (`every: VIDEO_SWEEPER_INTERVAL_MS`). The sweep re-enqueues stuck `processing` rows by job state (a retained failed job → `PROCESSING_FAILED`) and expires old drafts (abort → delete original → `UPLOAD_EXPIRED`). 1 attempt; the next tick retries.

### Video worker

- Runs in the `video-worker` Compose service as `npm run start:worker:dev` (ts-node, **no watch mode**): after changing worker code, run `docker compose restart video-worker`; check it with `docker compose logs video-worker`. `npm run start:worker` runs the built `dist/worker`.
- Job: `HeadObject` on the original → internal presigned GET (15 min) → `ffprobe` metadata → `ffmpeg` JPEG frame → `PutObject` thumbnail → `markReady`. `src/media/` (`FfmpegService`) wraps the binaries and classifies failures as invalid (permanent) or transient (retried).
- FFmpeg/ffprobe 5.1 come from `Dockerfile.dev` (shared by `nestjs-api` and `video-worker`); after changing it, `docker compose build && docker compose up -d`.
- `VideoWorkerModule` imports `UsersModule` only so `autoLoadEntities` registers `User` (target of `Channel#user`); otherwise TypeORM loops on `Entity metadata for Channel#user was not found`. Any new entity reachable from `Video` needs its owning module imported into the worker too.
- `VideoProcessor` and the sweeper are provided only by `VideoWorkerModule`; the API never consumes jobs.

### Storage

`StorageService` (`src/storage/`) is the only entry point to S3 and owns two clients: `internal` (`S3_ENDPOINT`) for every operation and `presign` (`S3_PUBLIC_ENDPOINT`) for signing client URLs only (signing is offline). Worker URLs are signed with the internal client. Both clients set `forcePathStyle` and `requestChecksumCalculation` / `responseChecksumValidation: 'WHEN_REQUIRED'`; the SDK default adds CRC32 checksums that presigned part URLs cannot satisfy. Key layout (`src/videos/video-storage-keys.ts`): `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. Match SDK errors by `err.name` (`NoSuchUpload`, `NotFound`, `InvalidPart`).

### Testing videos

- Tests use the real Compose `minio`, `redis` and `db` (Phase 03 decision IC-1). Do not add a filesystem storage adapter or mock Redis/S3 in integration and e2e tests.
- Any test module that imports `VideosModule` needs `redisConfig` loaded plus `QueueModule`, and must be closed (`module.close()` / `app.close()` in `finally`/`afterAll`), or Jest hangs on the open Redis connection. Obliterate the queues you touch (`queue.obliterate({ force: true })`).
- e2e auth: `createAuthenticatedUser(app, dataSource, email)` in `test/helpers/authenticated-user.ts`; clear the throttler storage in `beforeEach` (auth routes allow 10 req/min). Abort open multipart uploads before `cleanAllTables`.
- Video fixtures: generate them with `createTestVideo()` (`src/test/video-fixtures.ts`, lavfi H.264 MP4 in the OS temp dir) and delete the file afterwards; no binary fixtures in the repo.
- In-process worker: `Test.createTestingModule({ imports: [VideoWorkerModule] }).compile()` then `init()` starts the workers. `init()` also registers `video-sweeper` on `bull-test`, and a new scheduler runs one sweep immediately against the shared DB. Clean up with `removeJobScheduler('video-sweeper')` + obliterate `video-maintenance` (see `test/videos-pipeline.e2e-spec.ts`).

### Gotchas

- BullMQ 6 has no `queue.client`; use `queue.getBackend().client`.
- `queue.add` with an existing `jobId` resolves to a Job built from the *new* call's data/opts, not the stored one; read `queue.getJob(id)`. A retained failed or completed job with the same id makes the add a no-op until that job is removed.
- `docker compose stop video-worker` shuts down cleanly in ~1 s, but npm logs `command failed … signal SIGTERM` and exits 1 because Nest re-raises the signal after closing; this is cosmetic.
- `npm run openapi:export` boots `AppModule`, so Redis must be reachable.
- `nest-cli.json` has `deleteOutDir: true` and `dist/` is shared through the volume: never run a second `nest build`/`nest start` for the worker.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
