# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/16 completed

### SI-03.1 — Infra: Dependencies, Compose Storage/Queue Services and Configuration
- **Status:** completed
- **Tests:** 19 passing (`src/config/env.validation.integration-spec.ts`, 4 existing + 15 new); full suites 23 suites / 159 tests, e2e 3 suites / 52 tests
- **Observations:**
  - npm resolved newer patches inside the plan's ranges (`@nestjs/bullmq` 12.0.1, `bullmq` 6.7.1, `ioredis` 5.11.1, `@aws-sdk/*` 3.1164.0). `npm install` wrote the resolved versions as ranges, so `package.json` was reset to the exact plan pins (`^12.0.0`, `^6.6.1`, `^5.11.1`, `^3.1161.0`).
  - `minio-init` receives `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` through `environment:` — the plan's `$$S3_…` entrypoint reads them from the container env, which the Compose table did not list. The entrypoint uses list form (`[sh, -c, …]`) so Compose does not re-split the command.
  - Config factories keep fallbacks equal to the Joi defaults (`redis`, `6379`, `bull`, `us-east-1`, `streamtube-videos`, video numbers), never `localhost`, matching `mail.config.ts`. Required vars (S3 endpoints and credentials) have no fallback.
  - `test/jest-e2e.json` has `rootDir: "."` = `test/`, so its entry is `<rootDir>/../src/test/setup-test-env.ts`. The setup file only copies `S3_ENDPOINT` into `S3_PUBLIC_ENDPOINT` when it is defined (assigning `undefined` to `process.env` would store the string `"undefined"`).
  - context7 `/nestjs/docs.nestjs.com` (master) says Joi options go under `validationOptions.libraryOptions`; installed `@nestjs/config` 4.0.3 still passes `validationOptions` straight to Joi, so the existing `AppModule` pattern was kept.
  - AC checks: `redis`/`minio` healthy, `minio-init` exit 0, `maxmemory-policy` = `noeviction`, bucket `streamtube-videos` exists, `docker compose run --rm minio-init` re-run exit 0, `node dist/main` with empty `S3_ACCESS_KEY_ID` fails with `Config validation error`.

### SI-03.2 — Storage Module with Internal and Presign S3 Clients
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Queue Root Module and Shared Queue Contracts
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Video Entity, Migration and VideosModule Skeleton
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Video Naming and Sizing Rules
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Start Upload and Owner Read (POST /videos, GET /videos/:id)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Part Signing and Upload Resume (POST/GET /videos/:id/upload/parts)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Abort Upload (DELETE /videos/:id/upload)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Complete Upload and Enqueue Processing (POST /videos/:id/upload/complete)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Streaming and Download by Unique Slug (GET /videos/:slug/stream, GET /videos/:slug/download)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Infra: Video Worker Runtime and Compose Service
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Media Toolkit: ffprobe/ffmpeg Wrapper with Failure Classification
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Video Processing Job: Metadata, Thumbnail and Ready Transition
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Terminal Failure Handling and Configurable Worker Concurrency
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Maintenance Sweeper: Stuck Processing Reconciliation and Draft Expiry
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.16 — End-to-End Video Pipeline Verification
- **Status:** pending
- **Tests:** —
- **Observations:** none
