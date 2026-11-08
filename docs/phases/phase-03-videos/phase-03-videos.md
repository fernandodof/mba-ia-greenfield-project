---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-07T05:34:45-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-07T05:34:45-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-07T05:33:08-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-21T14:17:11-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of files up to 10 GB straight to S3-compatible object storage (with the video pre-registered as a draft when the upload starts), automatic background processing by a queue-fed video worker (duration/metadata extraction and thumbnail generation), a unique URL per video, and streaming and download — with object storage (MinIO/Silo), the queue (Redis/BullMQ) and the worker running as real Docker Compose services alongside the backend.

---

## Step Implementations

### SI-03.1 — Infra: Dependencies, Compose Storage/Queue Services and Configuration

**Description:** Install the Phase 03 libraries, add the Redis and Silo (MinIO) services plus the one-shot bucket initializer to Docker Compose, and create the `redis`, `storage` and `video` config namespaces with Joi validation, so every later SI runs against real infrastructure addressed by Compose service names.

**Technical actions:**

1. Install in `nestjs-project` (inside the container): `@nestjs/bullmq@^12.0.0`, `bullmq@^6.6.1`, `ioredis@^5.11.1` (explicit — optional peer of BullMQ 6), `@aws-sdk/client-s3@^3.1161.0`, `@aws-sdk/s3-request-presigner@^3.1161.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`; pins from `library-refs.md`)
2. Update `nestjs-project/compose.yaml` — add `redis`, `minio` and `minio-init` exactly as in `### Data Model → Compose services`: named volume `minio-data`; `minio` env `MINIO_ROOT_USER: ${S3_ACCESS_KEY_ID}` / `MINIO_ROOT_PASSWORD: ${S3_SECRET_ACCESS_KEY}`; `minio-init` entrypoint `sh -c "mc alias set local http://minio:9000 $$S3_ACCESS_KEY_ID $$S3_SECRET_ACCESS_KEY && mc mb --ignore-existing local/${S3_BUCKET:-streamtube-videos}"`; `nestjs-api.depends_on` gains `redis: service_healthy` and `minio-init: service_completed_successfully` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`)
3. Create `src/config/redis.config.ts`, `src/config/storage.config.ts`, `src/config/video.config.ts` — `registerAs('redis' | 'storage' | 'video', …)` reading the variables of `### Data Model → Configuration` (numbers parsed with `parseInt`; no `localhost` fallbacks); add them to `ConfigModule.forRoot({ load: [...] })` in `AppModule` (per `phase-01-configuracao-base/TD-03`)
4. Extend `src/config/env.validation.ts` with the 12 variables and rules of the Configuration table (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` `Joi.string().uri().required()`; `S3_ACCESS_KEY_ID` required; `S3_SECRET_ACCESS_KEY` `min(8)` required; the rest with defaults); add them to `.env.example` with Compose values (`S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `REDIS_HOST=redis`, …) and to the local `.env` (not committed) (per `phase-01-configuracao-base/TD-02`)
5. Create `src/test/setup-test-env.ts` — sets `process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT` and `process.env.QUEUE_PREFIX = 'bull-test'`; append it after `dotenv/config` in `jest.setupFiles` (`package.json`) and `test/jest-e2e.json` `setupFiles` (per `phase-03-videos/TD-06` IC-1 revision — in-container consumers need internal-host signatures; the prefix keeps test jobs away from the Compose `video-worker`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration (existing suite, extended): `requiredEnv` gains the S3 vars; missing `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` rejected; `S3_SECRET_ACCESS_KEY` shorter than 8 rejected; defaults `REDIS_HOST=redis`, `REDIS_PORT=6379`, `QUEUE_PREFIX=bull`, `S3_BUCKET=streamtube-videos`, `VIDEO_*` defaults; `VIDEO_WORKER_CONCURRENCY=0` rejected | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` → `redis` and `minio` report `healthy`, and `minio-init` exits with code 0
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` returns `noeviction`
- After `docker compose up -d`, the bucket `streamtube-videos` exists in `minio`; re-running `docker compose run --rm minio-init` exits 0 without error
- Booting the API without `S3_ACCESS_KEY_ID` fails Joi validation at startup and the app does not start
- The existing unit/integration and e2e suites pass unchanged with the new services and env in place

---

### SI-03.2 — Storage Module with Internal and Presign S3 Clients

**Description:** Create a domain-agnostic `StorageModule` that wraps both S3 clients behind one service (callers never pick an endpoint), exposing exactly the multipart, object and presign operations the phase needs, verified against the real Silo container.

**Technical actions:**

1. Create `src/storage/storage.errors.ts` — `UploadSessionNotFoundError` (S3 `NoSuchUpload`) and `InvalidUploadPartsError` (`InvalidPart` / `InvalidPartOrder`), plain `Error` subclasses (storage stays transport- and domain-agnostic); S3 errors are matched by `err.name` (per `library-refs.md` → `@aws-sdk/client-s3` → Error matching)
2. Create `src/storage/storage.service.ts` — `StorageService` builds two `S3Client`s from `storageConfig`: common options `region`, `credentials`, `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, `responseChecksumValidation: 'WHEN_REQUIRED'`; `internal` uses `S3_ENDPOINT` for every operation, `presign` uses `S3_PUBLIC_ENDPOINT` for signing only; both destroyed in `onModuleDestroy` (per `phase-03-videos/TD-02` revision, `phase-03-videos/TD-06`)
3. Multipart methods on `StorageService`: `createMultipartUpload(key, contentType): Promise<string>`, `presignUploadPart(key, uploadId, partNumber, expiresIn): Promise<string>` (public client), `listParts(key, uploadId): Promise<{ partNumber; etag; size }[]>` (paginates `IsTruncated` / `NextPartNumberMarker`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` — `NoSuchUpload` is converted into a successful no-op (tolerated by contract, per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`); `NoSuchUpload` / `InvalidPart*` from the other calls are rethrown as the errors of action 1
4. Object methods on `StorageService`: `headObject(key): Promise<{ size: number } | null>` (`NotFound` → `null`, any other error propagates), `deleteObject(key)`, `putObject(key, body: Buffer, contentType)`, `presignGetObject(key, { client: 'internal' | 'public', expiresIn, responseContentDisposition? })` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-11`; uses `@aws-sdk/s3-request-presigner` `getSignedUrl` with explicit `expiresIn`)
5. Create `src/storage/storage.module.ts` — provides and exports `StorageService`; bucket name read from `storageConfig.bucket`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (real `minio`): create → presign 2 parts → `fetch` PUT (5 MiB + 1 KiB) → `listParts` → complete → `headObject` size; internal presigned GET with `Range` → 206; `deleteObject` → `headObject` `null`; abort of unknown upload resolves; bogus ETag → `InvalidUploadPartsError`; `listParts` after abort → `UploadSessionNotFoundError`; presigned part URL has no `x-amz-sdk-checksum-algorithm` / `x-amz-checksum-*` query params | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation with `ConfigModule` + `storageConfig` | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (SDK installed, `minio` service + `storage` config)

**Acceptance criteria:**

- A presigned part URL accepts a plain `PUT` of the part bytes with no checksum headers and returns an `ETag`
- Completing a 2-part upload produces an object whose `HeadObject` size equals the sum of the uploaded parts
- An internal presigned GET with `Range: bytes=0-99` returns `206` with exactly 100 bytes
- Aborting an unknown or already-finished upload resolves without error; `HeadObject` on a missing key yields `null`; deleting a missing key succeeds
- URLs signed for public use carry the `S3_PUBLIC_ENDPOINT` host; internal URLs carry the `S3_ENDPOINT` host

---

### SI-03.3 — Queue Root Module and Shared Queue Contracts

**Description:** Connect the application to Redis through one `QueueModule` (BullMQ root config with the configurable key prefix) and define the queue names, job payloads and job options as a single shared contract that the API producer and the worker both import.

**Technical actions:**

1. Create `src/queue/queue.module.ts` — `QueueModule` wrapping `BullModule.forRootAsync({ imports: [ConfigModule], inject: [redisConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port }, prefix: cfg.queuePrefix }) })` (per `phase-03-videos/TD-01`); before implementing, confirm with context7 (`/nestjs/bull`, `/taskforcesh/bullmq/v6.5.3`) that the shared root `prefix` is also applied to workers created from `@Processor` classes
2. Create `src/videos/video-queue.constants.ts` — exactly the constants of `### Events/Messages` (`VIDEO_PROCESSING_QUEUE`, `VIDEO_PROCESS_JOB`, `VIDEO_MAINTENANCE_QUEUE`, `VIDEO_SWEEP_JOB`, `VIDEO_SWEEPER_SCHEDULER_ID`, `VideoProcessingJobData`, `VIDEO_PROCESSING_JOB_OPTIONS`, `VIDEO_MAINTENANCE_JOB_OPTIONS`) typed with BullMQ `JobsOptions` (per `phase-03-videos/TD-12`, `phase-03-videos/TD-04` revisions; validation note 1)
3. Import `QueueModule` in `AppModule` (global infrastructure, next to `ConfigModule` / `TypeOrmModule`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` + `VIDEO_PROCESSING_JOB_OPTIONS` | Integration (real `redis`): module compiles with `registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS })`; an added job is stored under `bull-test:video-processing:*`; `job.opts` carries `attempts: 3`, exponential backoff 10000, `removeOnFail.count` 1000; a second `add` with the same `jobId` returns the existing job; `module.close()` releases the connection (no open handles) | `src/queue/queue.module.integration-spec.ts` |

**Dependencies:** SI-03.1 (`redis` service, `redis` config, BullMQ installed)

**Acceptance criteria:**

- The API boots with `QueueModule` connected to `redis:6379` and `GET /` still returns `200`
- A job added to `video-processing` is stored under keys prefixed by the configured `QUEUE_PREFIX`
- A job added with the shared defaults carries `attempts: 3`, `backoff { type: 'exponential', delay: 10000 }`, `removeOnComplete: true`, `removeOnFail { count: 1000 }`
- Adding a job whose `jobId` already exists does not create a second job

---

### SI-03.4 — Video Entity, Migration and VideosModule Skeleton

**Description:** Create the `Video` entity linked to `Channel`, generate the `CreateVideos` migration, and register the new `VideosModule`, keeping the existing migration runner test and test data sources consistent with the new table and relation.

**Technical actions:**

1. Create `src/videos/video.types.ts` (`VideoStatus` enum `draft | processing | ready | failed`, `VideoFailureReason` union) and `src/videos/entities/video.entity.ts` — `@Entity('videos')` with every column, type, constraint and index of `### Data Model → Video` (`@PrimaryColumn('uuid') id`, `size_bytes` bigint with a `number` transformer, `processing_started_at` `timestamptz`), `@ManyToOne(() => Channel, (c) => c.videos)` + `@JoinColumn({ name: 'channel_id' })`; add the inverse `@OneToMany(() => Video, (v) => v.channel) videos: Video[]` to `src/channels/entities/channel.entity.ts` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`, `phase-03-videos/TD-10`, `phase-03-videos/TD-12`, `phase-03-videos/TD-13`)
2. Create `src/videos/videos.module.ts` — `VideosModule` with `TypeOrmModule.forFeature([Video])`; register it in `AppModule`
3. Generate the migration: `npm run migration:generate -- src/database/migrations/CreateVideos`; review the SQL (`videos_status_enum`, FK `channel_id → channels.id`, unique `slug`, indexes `(channel_id)`, `(status, created_at)`, `(status, processing_started_at)`, `down()` drops table then enum)
4. Update `src/database/migrations.integration-spec.ts` — add the `CreateVideos<timestamp>` class to the `MIGRATIONS` array, `videos` to `MANAGED_TABLES` and to the expected table list, `Video` to the entity array; the revert test now asserts that `undoLastMigration()` removes `videos` (the last migration is now `CreateVideos`, no longer `CreateAuthTokens`)
5. Update `src/test/create-test-data-source.ts` — `cleanAllTables` deletes `"videos"` first (FK to `channels`); add `Video` to every test entity array that contains `Channel` (`auth.module.spec.ts`, `auth.service.integration-spec.ts`, `refresh-token.entity.integration-spec.ts`, `verification-token.entity.integration-spec.ts`, `channels.module.spec.ts`, `channels.service.integration-spec.ts`, `channel.entity.integration-spec.ts`, `user.entity.integration-spec.ts`, `users.module.spec.ts`, `users.service.integration-spec.ts`) — TypeORM needs the `Video` metadata to resolve `Channel.videos`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: unique `slug`, `status` default `draft`, enum rejects unknown values, FK to `channels`, nullable media/failure columns, `size_bytes` 10 GiB round-trips as `number`, timestamps auto-populated | `src/videos/entities/video.entity.integration-spec.ts` |
| Migration runner | Integration (existing suite, updated): all 3 migrations apply and create the 5 tables; reverting the last migration removes `videos` | `src/database/migrations.integration-spec.ts` |
| `VideosModule` | Unit: compilation with `TypeOrmModule.forFeature([Video])` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 (env and Compose in place so the full suite stays green)

**Acceptance criteria:**

- `npm run migration:run` creates `videos` with all Data Model columns, the `videos_status_enum` type, the FK to `channels`, the unique `slug` constraint and the three indexes; `npm run migration:revert` drops them
- Inserting two videos with the same `slug` fails with a unique constraint violation
- A video inserted without `status` is stored as `draft`; inserting `status = 'published'` is rejected by the enum
- Inserting a video with a `channel_id` that does not exist fails with a foreign key violation
- `size_bytes = 10737418240` is read back as the JS number `10737418240`
- The existing unit/integration suites pass with `Video` added to their entity arrays and to `cleanAllTables`

---

### SI-03.5 — Video Naming and Sizing Rules

**Description:** Implement the pure rules the upload endpoints depend on — code-point length validation, default title derivation, slug generation and part sizing — as small unit-tested functions, so the HTTP SIs only wire them.

**Technical actions:**

1. Create `src/common/validators/max-code-points.validator.ts` — `@MaxCodePoints(n)` class-validator decorator (`registerDecorator`) that fails non-strings and strings with `Array.from(value).length > n` (validation note 4; per `phase-03-videos/TD-03` IC-2 revision)
2. Create `src/videos/video-title.util.ts` — `truncateCodePoints(value, max)` (`Array.from(value).slice(0, max).join('')`) and `deriveVideoTitle(title: string | undefined, filename: string): string` — returns the trimmed `title` when given; otherwise drops the last extension (from the last `.` to the end, when there is a `.`), trims and cuts to 100 code points, falling back to the full `filename` trimmed and cut to 100 when that is empty (per `phase-03-videos/TD-03` IC-2 revision)
3. Create `src/videos/video-slug.util.ts` — `generateVideoSlug(): string` = `randomBytes(8).toString('base64url')` from `node:crypto` (per `phase-03-videos/TD-10`)
4. Create `src/videos/video.constants.ts` — the fixed constants of `### Data Model → Configuration` (`VIDEO_MAX_SIZE_BYTES`, `VIDEO_PART_SIZE_BYTES`, `VIDEO_MAX_PART_COUNT`, URL TTLs, media timeouts/buffer) and `computePartCount(sizeBytes) = Math.ceil(sizeBytes / VIDEO_PART_SIZE_BYTES)` (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MaxCodePoints` | Unit: ASCII and astral (emoji) boundaries at n and n+1, non-string rejected | `src/common/validators/max-code-points.validator.spec.ts` |
| `deriveVideoTitle` / `truncateCodePoints` | Unit: explicit title trimmed; multi-dot filename; `.mp4`-only filename; no extension; 300-char filename; surrogate pair at the cut boundary | `src/videos/video-title.util.spec.ts` |
| `generateVideoSlug` | Unit: length 11, base64url alphabet, distinct across calls | `src/videos/video-slug.util.spec.ts` |
| `computePartCount` | Unit: 1 B → 1, 64 MiB → 1, 64 MiB + 1 → 2, 10 GiB → 160 | `src/videos/video.constants.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A title made of 100 emoji (100 code points, 200 UTF-16 units) passes `@MaxCodePoints(100)`; 101 code points fail
- `deriveVideoTitle(undefined, 'My clip.final.mp4')` returns `My clip.final`; `deriveVideoTitle(undefined, '.mp4')` returns `.mp4`
- A derived title from a 300-code-point filename has exactly 100 code points and never ends in half of a surrogate pair
- `generateVideoSlug()` returns an 11-character string matching `^[A-Za-z0-9_-]{11}$`
- `computePartCount(10737418240)` returns `160` and `computePartCount(67108865)` returns `2`

---

### SI-03.6 — Start Upload and Owner Read (POST /videos, GET /videos/:id)

**Route:** POST /videos, GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-start-upload.plan.md`
**Authorization:** Authenticated (POST); Owner (GET — non-owner → `404`)

**Description:** Pre-register the video as a `draft` in the caller's channel while opening the S3 multipart session, and let the owner read the video's lifecycle state — the entry point of the upload flow and the first `VideosController` routes.

**Technical actions:**

1. Add `ChannelsService.findByUserId(userId): Promise<Channel | null>` in `src/channels/channels.service.ts` (channel lookup stays in the channels module)
2. Create `src/videos/videos.exceptions.ts` (`VideoNotFoundException`, `VideoUploadNotActiveException`, `UploadPartsInvalidException`, `UploadSizeMismatchException` — codes, statuses and messages of `### Error Catalog`, extending `DomainException`) and `src/videos/video-storage-keys.ts` (`originalKey(id)` = `videos/{id}/original`, `thumbnailKey(id)` = `videos/{id}/thumbnail.jpg`) (per `phase-03-videos/TD-05`, `phase-02-auth/TD-07`)
3. Create `src/videos/videos.service.ts` — `startUpload(userId, dto)`: resolve the caller's channel (absent → plain `Error`, phase-02 invariant), `id = randomUUID()`, `storage.createMultipartUpload(originalKey(id), dto.contentType)`, insert the row (`deriveVideoTitle`, `generateVideoSlug`, `original_filename`, `content_type`, `size_bytes`, `upload_id`) retrying up to 3 times with a new slug only on a unique violation of the `slug` constraint (standalone inserts, no transaction), and on final failure `abortMultipartUpload` then rethrow; returns `{ id, slug, status, partSize, partCount }`. `findOwnedById(userId, id)`: query joined on `channel.user_id = :userId`, none → `VideoNotFoundException` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-10`)
4. Create DTOs `src/videos/dto/create-video.dto.ts` (rules of `#### Validation Rules — videos`, `@MaxCodePoints`), `src/videos/dto/video-upload-session.dto.ts` and `src/videos/dto/video.dto.ts` (response DTOs with `@ApiProperty`, nullable fields `{ required: false, nullable: true }`, field names exactly as in `### API Contracts → GET /videos/:id`)
5. Create `src/videos/videos.controller.ts` — `@ApiTags('videos')`, `@Controller('videos')`, `@SkipThrottle()`; `POST /videos` (`201`) and `GET /videos/:id` (`ParseUUIDPipe`) with `@CurrentUser()`, `@ApiBearerAuth('access-token')`, `@ApiOperation` and one `@ApiResponse` per status (`ApiErrorEnvelope` for errors); `VideosModule` imports `ChannelsModule` and `StorageModule` and declares the controller and service; regenerate `openapi.json` (`npm run openapi:export`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.startUpload` / `findOwnedById` | Unit (mock repo/storage/channels): default title used when omitted; slug collision retried then succeeds; 3 collisions → `abortMultipartUpload` called and error rethrown; non-slug unique violation not retried; `partCount` computed; not-owned → `VideoNotFoundException` | `src/videos/videos.service.spec.ts` |
| `VideosService.startUpload` / `findOwnedById` | Integration (real DB + `minio`): row persisted as `draft` with `upload_id`; `listParts` on the stored upload returns `[]`; another user's id → `VIDEO_NOT_FOUND` | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration (existing suite, extended): returns the user's channel; unknown user → `null` | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (storage), SI-03.4 (entity/module), SI-03.5 (title/slug/size rules)

**Acceptance criteria:**

- `POST /videos` with `{ filename: 'clip.mp4', size: 1048576, contentType: 'video/mp4' }` returns `201` with `{ id, slug (11 chars), status: 'draft', partSize: 67108864, partCount: 1 }`, and the stored `title` is `clip`
- A multipart upload for `videos/{id}/original` exists in storage right after `POST /videos` returns
- `POST /videos` with a 101-code-point `title`, `size: 10737418241` or `contentType: 'image/png'` returns `400` with `error: "VALIDATION_ERROR"`
- `POST /videos` without an access token returns `401`
- `GET /videos/:id` by the owner returns `200` with every documented field (`durationMs: null`, `failureReason: null` for a fresh draft) and no `uploadId`, `thumbnailKey` or `processingStartedAt`
- `GET /videos/:id` for another user's video returns `404` with `error: "VIDEO_NOT_FOUND"`; a malformed id returns `400`

---

### SI-03.7 — Part Signing and Upload Resume (POST/GET /videos/:id/upload/parts)

**Route:** POST /videos/:id/upload/parts, GET /videos/:id/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner (non-owner → `404`)

**Description:** Hand the owner short-lived presigned part URLs so the file bytes go straight to storage (never through the API), and list already-uploaded parts so an interrupted upload can resume.

**Technical actions:**

1. Add `VideosService.signUploadParts(userId, id, partNumbers)` — `findOwnedById`; not `draft` → `VideoUploadNotActiveException`; any part number > `computePartCount(size_bytes)` → `UploadPartsInvalidException`; presign each with `storage.presignUploadPart(originalKey(id), upload_id, n, UPLOAD_PART_URL_TTL_SECONDS)`; returns `{ parts: [{ partNumber, url }], expiresAt }` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
2. Add `VideosService.listUploadedParts(userId, id)` — `findOwnedById`; not `draft` → `VideoUploadNotActiveException`; `storage.listParts(...)`; `UploadSessionNotFoundError` → `VideoUploadNotActiveException` (per `phase-03-videos/TD-03` AMB-7 revision)
3. Create `src/videos/dto/sign-upload-parts.dto.ts` (`partNumbers` rules of `#### Validation Rules — videos`) and response DTOs `src/videos/dto/signed-upload-parts.dto.ts`, `src/videos/dto/uploaded-parts.dto.ts`
4. Add to `VideosController`: `@Post(':id/upload/parts')` with `@HttpCode(200)` and `@Get(':id/upload/parts')`, both `ParseUUIDPipe`, `@ApiBearerAuth('access-token')`, `@ApiResponse` for 200/400/401/404/409; regenerate `openapi.json`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.signUploadParts` / `listUploadedParts` | Unit (mock repo/storage): non-draft → 409 exception; part number above `partCount` → `UploadPartsInvalidException`; `expiresAt` = now + 3600 s; `UploadSessionNotFoundError` mapped to `VideoUploadNotActiveException` | `src/videos/videos.service.spec.ts` |
| `VideosService.signUploadParts` / `listUploadedParts` | Integration (real DB + `minio`): signed URL accepts a `fetch` PUT; `listUploadedParts` then returns `{ partNumber: 1, etag, size }`; after aborting the upload directly in storage → `VideoUploadNotActiveException` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 (controller, service, owner lookup)

**Acceptance criteria:**

- `POST /videos/:id/upload/parts` with `{ partNumbers: [1] }` on the owner's draft returns `200` with one `url` whose host is the `S3_PUBLIC_ENDPOINT` host and an `expiresAt` about one hour ahead
- A `PUT` of the part bytes to the returned `url` succeeds and returns an `ETag`
- `partNumbers` containing `partCount + 1` returns `400` with `error: "UPLOAD_PARTS_INVALID"`; an empty or duplicated `partNumbers` returns `400` with `error: "VALIDATION_ERROR"`
- `GET /videos/:id/upload/parts` after uploading part 1 returns `200` with `parts: [{ partNumber: 1, etag, size }]`
- Both routes return `409` with `error: "VIDEO_UPLOAD_NOT_ACTIVE"` for a non-draft video, and `GET` also returns it when the storage upload no longer exists
- Both routes return `404` with `error: "VIDEO_NOT_FOUND"` for another user's video

---

### SI-03.8 — Abort Upload (DELETE /videos/:id/upload)

**Route:** DELETE /videos/:id/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-abort.plan.md`
**Authorization:** Owner (non-owner → `404`)

**Description:** Let the owner abort an in-progress upload, releasing storage and keeping the row as an auditable `failed`/`UPLOAD_ABORTED` video; introduces `VideoLifecycleService` as the single home of guarded status writes.

**Technical actions:**

1. Create `src/videos/video-lifecycle.service.ts` — `VideoLifecycleService.failDraft(id, reason: 'UPLOAD_ABORTED' | 'UPLOAD_EXPIRED' | 'UPLOAD_SIZE_MISMATCH'): Promise<boolean>` = `UPDATE videos SET status = 'failed', failure_reason = :reason, upload_id = NULL WHERE id = :id AND status = 'draft'`, returning whether a row was affected; provided and exported by `VideosModule` (per `phase-03-videos/TD-12`)
2. Add `VideosService.abortUpload(userId, id)` — `findOwnedById`; not `draft` → `VideoUploadNotActiveException` (no storage call); `storage.abortMultipartUpload(originalKey(id), upload_id)` (`NoSuchUpload` tolerated); `storage.deleteObject(originalKey(id))`; `failDraft(id, 'UPLOAD_ABORTED')` returning `false` → `VideoUploadNotActiveException` (validation note 2: a concurrent `complete` won; that video later ends `failed`/`SOURCE_MISSING` in the worker, a consistent terminal state) (per `phase-03-videos/TD-03` AMB-5 and AMB-7 revisions)
3. Add to `VideosController`: `@Delete(':id/upload')` with `@HttpCode(204)`, `ParseUUIDPipe`, `@ApiBearerAuth('access-token')`, `@ApiResponse` for 204 (no schema)/400/401/404/409; regenerate `openapi.json`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoLifecycleService.failDraft` | Integration (real DB): updates only `draft` rows, clears `upload_id`, returns `false` for `processing`/`ready`/`failed` | `src/videos/video-lifecycle.service.integration-spec.ts` |
| `VideosService.abortUpload` | Unit (mock repo/storage/lifecycle): non-draft → 409 exception without storage calls; guarded update miss → `VideoUploadNotActiveException`; call order abort → delete → update | `src/videos/videos.service.spec.ts` |
| `VideosService.abortUpload` | Integration (real DB + `minio`): multipart upload gone, original key absent, row `failed`/`UPLOAD_ABORTED` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 (controller, service, owner lookup)

**Acceptance criteria:**

- `DELETE /videos/:id/upload` on the owner's draft returns `204`; the row becomes `status = 'failed'`, `failure_reason = 'UPLOAD_ABORTED'`, `upload_id = NULL`
- After the abort, the multipart upload no longer exists in storage and `videos/{id}/original` is absent
- `DELETE /videos/:id/upload` succeeds with `204` even when the storage upload had already been aborted or expired
- `DELETE /videos/:id/upload` on a `processing`, `ready` or `failed` video returns `409` with `error: "VIDEO_UPLOAD_NOT_ACTIVE"`
- An abort whose guarded update finds the video no longer `draft` returns `409` with `error: "VIDEO_UPLOAD_NOT_ACTIVE"`
- `DELETE /videos/:id/upload` on another user's video returns `404` with `error: "VIDEO_NOT_FOUND"`

---

### SI-03.9 — Complete Upload and Enqueue Processing (POST /videos/:id/upload/complete)

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner (non-owner → `404`)

**Description:** Finish the multipart upload, verify the stored size, move the video `draft → processing` and enqueue the processing job after the commit — idempotent across retries and across the storage-complete/DB-commit crash window.

**Technical actions:**

1. Create `src/videos/video-processing.queue.ts` — `VideoProcessingQueue` (`@InjectQueue(VIDEO_PROCESSING_QUEUE)`): `enqueue(videoId)` = `queue.add(VIDEO_PROCESS_JOB, { videoId }, { jobId: videoId })`; `getJobState(videoId): Promise<JobState | 'unknown' | 'missing'>` (`getJob` → `undefined` → `'missing'`, else `job.getState()`); `removeJob(videoId)`. `VideosModule` imports `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS })` and exports `VideoProcessingQueue` and `VideoLifecycleService` — the one declaration used by the API and (via `VideosModule`) by the worker (validation note 1; per `phase-03-videos/TD-12`, `phase-03-videos/TD-13`)
2. Add `VideoLifecycleService.markProcessing(id): Promise<boolean>` — `UPDATE videos SET status = 'processing', upload_id = NULL, processing_started_at = now() WHERE id = :id AND status = 'draft'` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-13`)
3. Add `VideosService.completeUpload(userId, id, parts)` — `findOwnedById`; `processing` → `enqueue` and return `{ id, slug, status: 'processing' }`; `ready`/`failed` → `VideoUploadNotActiveException`; `draft`: parts not exactly `partCount` in strictly ascending order → `UploadPartsInvalidException`; `storage.completeMultipartUpload` (`InvalidUploadPartsError` → `UploadPartsInvalidException`; `UploadSessionNotFoundError` → continue only if `headObject` finds the object, else `VideoUploadNotActiveException`); `headObject` size ≠ `size_bytes` → `deleteObject`, `failDraft(id, 'UPLOAD_SIZE_MISMATCH')`, `UploadSizeMismatchException`; `markProcessing` (`false` → re-read: now `processing` → idempotent success, otherwise `VideoUploadNotActiveException`); then `enqueue` (per `phase-03-videos/TD-03` AMB-5/AMB-7 revisions, `phase-03-videos/TD-13`)
4. Create `src/videos/dto/complete-upload.dto.ts` (`parts` / `CompletedPartDto` rules of `#### Validation Rules — videos`) and response DTO `src/videos/dto/video-processing-started.dto.ts`; add `@Post(':id/upload/complete')` with `@HttpCode(200)`, `ParseUUIDPipe`, `@ApiBearerAuth('access-token')`, `@ApiResponse` for 200/400/401/404/409/422 to `VideosController`; regenerate `openapi.json`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (mock repo/storage/lifecycle/queue): every branch of action 3, including enqueue only after a successful `markProcessing`, re-enqueue on `processing`, guarded-update miss handling | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (real DB + `minio` + `redis`): happy path → row `processing` + job with `attempts: 3`; second call idempotent; `NoSuchUpload` with the object present (completed directly in storage first) → `processing`; size mismatch → object deleted + `failed`/`UPLOAD_SIZE_MISMATCH` | `src/videos/videos.service.integration-spec.ts` |
| `VideoProcessingQueue` | Integration (real `redis`, `bull-test` prefix): `enqueue` twice → one job with `jobId = videoId` and payload `{ videoId }`; `getJobState` → `'missing'` for an unknown id, `'waiting'` after enqueue | `src/videos/video-processing.queue.integration-spec.ts` |
| `VideoLifecycleService.markProcessing` | Integration (existing suite, extended): only from `draft`; sets `processing_started_at`, clears `upload_id` | `src/videos/video-lifecycle.service.integration-spec.ts` |

**Dependencies:** SI-03.3 (queue root + shared contracts), SI-03.7 (parts flow used to upload), SI-03.8 (`VideoLifecycleService.failDraft`)

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` with every uploaded part returns `200` with `{ id, slug, status: 'processing' }`; the row has `upload_id = NULL` and `processing_started_at` set
- After a successful completion, `video-processing` holds a `process` job with `jobId = videoId`, payload `{ videoId }` and `attempts: 3`
- Repeating the call returns the same `200` body and `video-processing` still holds exactly one job for that video
- A part with a wrong `etag`, or fewer parts than `partCount`, returns `400` with `error: "UPLOAD_PARTS_INVALID"` and the video stays `draft`
- A declared `size` different from the uploaded bytes returns `422` with `error: "UPLOAD_SIZE_MISMATCH"`; the row becomes `failed`/`UPLOAD_SIZE_MISMATCH` and `videos/{id}/original` is deleted
- When storage had already completed the upload but the row is still `draft`, the call returns `200` with `status: 'processing'`
- When the storage upload is gone and no object exists, the call returns `409` with `error: "VIDEO_UPLOAD_NOT_ACTIVE"` and the row stays `draft`
- The call on a `ready` or `failed` video returns `409` with `error: "VIDEO_UPLOAD_NOT_ACTIVE"`

---

### SI-03.10 — Streaming and Download by Unique Slug (GET /videos/:slug/stream, GET /videos/:slug/download)

**Route:** GET /videos/:slug/stream, GET /videos/:slug/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Public (`@Public()`), `ready` videos only

**Description:** Serve playback and download of `ready` videos through their unique slug by redirecting to short-lived presigned GET URLs, so storage handles `Range`/`206` and the API stays out of the data path.

**Technical actions:**

1. Create `src/videos/download-filename.util.ts` — `buildDownloadContentDisposition(title, originalFilename): string` producing `attachment; filename="<ascii>"; filename*=UTF-8''<encoded>` with the sanitizing, extension and encoding rules of `### API Contracts → GET /videos/:slug/download` (per `phase-03-videos/TD-11` AMB-8 revision)
2. Add `VideosService.getPlaybackUrl(slug, mode: 'stream' | 'download'): Promise<string>` — `findOne({ where: { slug, status: VideoStatus.Ready } })`, none → `VideoNotFoundException` (unknown and non-`ready` alike); `storage.presignGetObject(originalKey(id), { client: 'public', expiresIn: PLAYBACK_URL_TTL_SECONDS, responseContentDisposition })` with the disposition only for `download` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-14`)
3. Add to `VideosController`: `@Public()` `@Get(':slug/stream')` and `@Get(':slug/download')` with `@Redirect()` (return `{ url, statusCode: 302 }`) and `@Header('Cache-Control', 'no-store')`; no `@ApiBearerAuth`; `@ApiResponse` for 302 (`Location` header) and 404; regenerate `openapi.json`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildDownloadContentDisposition` | Unit: forbidden characters removed, whitespace collapsed, trailing dots trimmed, empty → `video`, extension kept/lower-cased/omitted (`noext`, 11-char extension), non-ASCII → `_` in `filename`, RFC 5987 encoding incl. `'()*` in `filename*` | `src/videos/download-filename.util.spec.ts` |
| `VideosService.getPlaybackUrl` | Unit (mock repo/storage): `draft`/`processing`/`failed`/unknown → `VideoNotFoundException`; disposition passed only for `download` | `src/videos/videos.service.spec.ts` |
| `VideosService.getPlaybackUrl` | Integration (real DB + `minio`): `ready` row with an object put directly → stream URL answers `Range: bytes=0-1023` with `206` and the object's `Content-Type`; download URL answers with `Content-Disposition: attachment…` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 (controller, service, storage keys)

**Acceptance criteria:**

- `GET /videos/:slug/stream` for a `ready` video without an access token returns `302` with `Cache-Control: no-store` and a `Location` on the `S3_PUBLIC_ENDPOINT` host
- Requesting that `Location` with `Range: bytes=0-1023` returns `206` with 1024 bytes and the video's declared `Content-Type`
- `GET /videos/:slug/download` returns `302`; requesting its `Location` returns `Content-Disposition: attachment; filename="F_rias dia 12.mp4"; filename*=UTF-8''F%C3%A9rias%20dia%2012.mp4` for title `Férias: dia 1/2` and original file `clip.MP4`
- An `original_filename` without a valid extension (`noext`, `a.verylongext1`) yields a download name without extension
- `GET /videos/:slug/stream` and `/download` return `404` with `error: "VIDEO_NOT_FOUND"` for an unknown slug and for `draft`, `processing` and `failed` videos

---

### SI-03.11 — Infra: Video Worker Runtime and Compose Service

**Description:** Stand up the video worker as a separate process and Compose service from the same codebase (no HTTP server), with FFmpeg installed in the shared dev image so the worker and the in-container test suites use the same binaries.

**Technical actions:**

1. Update `Dockerfile.dev` — `apt install -y procps curl ffmpeg` (bookworm apt, FFmpeg 5.1.x, `7:5.1.9-0+deb12u1`); rebuild with `docker compose build` (per `phase-03-videos/TD-09`; `library-refs.md` → ffmpeg / ffprobe)
2. Extract shared bootstrap pieces used by both processes: `src/config/config-module.options.ts` (the `ConfigModule.forRoot` options — `isGlobal`, `load` list incl. `redis`/`storage`/`video`, `validationSchema`, `validationOptions`) and `src/database/database.module.ts` (the current `TypeOrmModule.forRootAsync` factory); `AppModule` switches to them with no behavior change (per inherited convention: database parameters sourced from a single `databaseConfig` factory, never duplicated)
3. Create `src/video-worker/video-worker.module.ts` — `VideoWorkerModule` importing `ConfigModule.forRoot(configModuleOptions)`, `DatabaseModule`, `QueueModule`, `StorageModule`, `VideosModule` and `BullModule.registerQueue({ name: VIDEO_MAINTENANCE_QUEUE, defaultJobOptions: VIDEO_MAINTENANCE_JOB_OPTIONS })`; create `src/worker.ts` — `NestFactory.createApplicationContext(VideoWorkerModule)` + `enableShutdownHooks()` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-04` revision)
4. Add `package.json` scripts: `start:worker:dev` = `ts-node -r tsconfig-paths/register src/worker.ts` (no `nest build`, so the worker never runs `deleteOutDir` on the `dist/` shared with the API through the volume) and `start:worker` = `node dist/worker` (production, after `npm run build`)
5. Add the `video-worker` service to `compose.yaml` exactly as in `### Data Model → Compose services` (same build and volume as `nestjs-api`, `command: npm run start:worker:dev`, depends on `db` healthy, `redis` healthy, `minio-init` completed, `restart: unless-stopped`, no ports) (per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoWorkerModule` | Unit: compilation test with real config, DB and Redis (`bull-test` prefix); `module.close()` releases handles | `src/video-worker/video-worker.module.spec.ts` |

**Dependencies:** SI-03.3 (queue root + contracts), SI-03.9 (`VideosModule` exports `VideoProcessingQueue` / `VideoLifecycleService` and registers `video-processing`)

**Acceptance criteria:**

- `docker compose up -d` starts `video-worker`, and `docker compose ps` shows it running (not restarting) after 30 s, with logs showing the Nest application context initialized
- `docker compose exec nestjs-api ffprobe -version` and `docker compose exec video-worker ffmpeg -version` both report FFmpeg 5.1.x
- `video-worker` publishes no port and the API keeps answering `GET /` with `200`
- `docker compose stop video-worker` stops the worker within the default grace period (shutdown hooks close Redis and DB connections)
- The full unit/integration and e2e suites still pass after the `AppModule` refactor

---

### SI-03.12 — Media Toolkit: ffprobe/ffmpeg Wrapper with Failure Classification

**Description:** Wrap ffprobe and ffmpeg behind a `MediaModule` that reads the original over a presigned HTTP URL (no 10 GB local copy), parses metadata, extracts a JPEG frame and classifies failures as transient (retry) or permanent.

**Technical actions:**

1. Create `src/media/media.constants.ts` — `TRANSIENT_FFMPEG_STDERR_PATTERNS` = `['Connection refused', 'Connection reset', 'timed out', 'Server returned 5', 'Server returned 403', 'Input/output error', 'I/O error', 'Failed to resolve hostname']`, matched case-insensitively (one exported constant, per `phase-03-videos/TD-09` AMB-10 revision)
2. Create `src/media/media.errors.ts` — `TransientMediaError` (timeout or transient stderr) and `InvalidMediaError` (non-transient ffprobe failure, unparsable JSON, no video stream, missing/non-positive duration)
3. Create `src/media/ffmpeg.service.ts` — `FfmpegService` using `child_process.execFile` (no shell) behind an injectable `EXEC_FILE` token: `probe(url): Promise<{ durationMs; width; height; videoCodec }>` runs `ffprobe -v error -print_format json -show_format -show_streams <url>` (timeout `MEDIA_COMMAND_TIMEOUT_MS`), `durationMs = round(format.duration × 1000)`, first `codec_type = 'video'` stream; `extractFrame(url, t): Promise<Buffer | null>` runs `ffmpeg -v error -ss <t> -i <url> -frames:v 1 -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2" -q:v 3 -f mjpeg pipe:1` (`maxBuffer` `THUMBNAIL_MAX_BUFFER_BYTES`, `encoding: 'buffer'`) — exit 0 with empty stdout → `null`, transient → `TransientMediaError`, other non-zero → `null` (caller decides the fallback) (per `phase-03-videos/TD-09` AMB-2/AMB-3/AMB-10 revisions)
4. Create `src/media/media.module.ts` (provides/exports `FfmpegService`, provides `EXEC_FILE`) and the test helper `src/test/video-fixtures.ts` — generates a short H.264 MP4 into `os.tmpdir()` with `ffmpeg -f lavfi -i testsrc=duration=<s>:size=320x240:rate=10 -pix_fmt yuv420p` (no binary fixtures committed)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Unit (mocked `EXEC_FILE`): each transient pattern (mixed case) → `TransientMediaError`; timeout (`killed`/`ETIMEDOUT`) → transient; other stderr → `InvalidMediaError` (probe) / `null` (frame); bad JSON, no video stream, duration `0`/missing → `InvalidMediaError`; duration rounding | `src/media/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration (real ffmpeg + `minio`): generated 2 s 320×240 MP4 behind an internal presigned GET → metadata; frame at `t = 1` is a JPEG; random bytes → `InvalidMediaError`; URL on `http://minio:9/…` → `TransientMediaError` | `src/media/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (internal presigned GET for integration), SI-03.11 (ffmpeg in the image)

**Acceptance criteria:**

- Probing a generated 2 s 320×240 H.264 MP4 through an internal presigned URL returns `durationMs` 2000 (± 100), `width` 320, `height` 240, `videoCodec` `h264`
- Extracting a frame at `t = 1` returns a buffer starting with the JPEG marker `FF D8` whose decoded size fits within 1280×720 with even dimensions
- Probing an object that is not a video fails as invalid media
- Probing a URL whose host refuses connections fails as a transient error
- Any stderr containing one of the eight patterns (any letter case) is classified transient; other stderr is permanent

---

### SI-03.13 — Video Processing Job: Metadata, Thumbnail and Ready Transition

**Description:** Consume `video-processing` jobs in the worker: verify the original, extract duration and metadata, generate and store the thumbnail, and move the video to `ready` — throwing unrecoverable errors for permanent media problems and normal errors for transient ones.

**Technical actions:**

1. Add to `VideoLifecycleService`: `findById(id)` and `markReady(id, { durationMs, width, height, videoCodec, thumbnailKey }): Promise<boolean>` = guarded `UPDATE … SET status = 'ready', duration_ms, width, height, video_codec, thumbnail_key WHERE id = :id AND status = 'processing'` (per `phase-03-videos/TD-09` AMB-2 revision, `phase-03-videos/TD-12`)
2. Create `src/video-worker/video-processing.errors.ts` — `VideoProcessingFailure extends UnrecoverableError` (from `bullmq`) carrying `reason: 'INVALID_MEDIA' | 'THUMBNAIL_FAILED' | 'SOURCE_MISSING'` (per `phase-03-videos/TD-12` revisions)
3. Create `src/video-worker/video-processing.service.ts` — `VideoProcessingService.process(videoId)`: row not `processing` → return (redelivery no-op); `storage.headObject(originalKey)` `null` → `VideoProcessingFailure('SOURCE_MISSING')` (other errors propagate → retry); sign an internal GET (`WORKER_SOURCE_URL_TTL_SECONDS`, fresh per attempt); `ffmpeg.probe` (`InvalidMediaError` → `VideoProcessingFailure('INVALID_MEDIA')`, `TransientMediaError` propagates); `t = min(1, durationMs / 2000)`; `extractFrame(url, t)` → `null` and `t > 0` → `extractFrame(url, 0)` → `null` → `VideoProcessingFailure('THUMBNAIL_FAILED')` (a transient error at `t > 0` propagates without the fallback); `storage.putObject(thumbnailKey(id), jpeg, 'image/jpeg')`; `markReady` (per `phase-03-videos/TD-09` AMB-3/AMB-10 revisions)
4. Create `src/video-worker/video.processor.ts` — `VideoProcessor extends WorkerHost`, `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })`, `process(job: Job<VideoProcessingJobData>)` delegates to `VideoProcessingService.process(job.data.videoId)`; `VideoWorkerModule` imports `MediaModule` and provides `VideoProcessingService` and `VideoProcessor` (the API never registers the processor) (per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit (mock lifecycle/storage/ffmpeg): non-`processing` → no-op; `headObject` `null` → `SOURCE_MISSING`; `InvalidMediaError` → `INVALID_MEDIA`; transient probe → plain rethrow; `null` frame at `t > 0` → retry at `t = 0`; both `null` → `THUMBNAIL_FAILED`; transient at `t > 0` → rethrow, no fallback; `t` for 0.4 s / 2 s / 10 s durations | `src/video-worker/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration (real DB + `minio` + ffmpeg): `processing` row + generated MP4 → `ready` with metadata and a `thumbnail.jpg` object (`image/jpeg`); random bytes → `VideoProcessingFailure` `INVALID_MEDIA` (row still `processing` — the terminal write is SI-03.14); no object → `SOURCE_MISSING` | `src/video-worker/video-processing.service.integration-spec.ts` |
| `VideoLifecycleService.markReady` | Integration (existing suite, extended): only from `processing`; all metadata columns written | `src/videos/video-lifecycle.service.integration-spec.ts` |

**Dependencies:** SI-03.11 (worker module), SI-03.12 (media toolkit)

**Acceptance criteria:**

- Processing a `processing` video whose original is a valid MP4 sets `status = 'ready'`, `duration_ms`, `width`, `height`, `video_codec` and `thumbnail_key = 'videos/{id}/thumbnail.jpg'`, and that object exists with `Content-Type: image/jpeg`
- Processing a video that is already `ready` (redelivered job) changes nothing in the row or in storage
- An original that is not a video fails the job with an unrecoverable `INVALID_MEDIA` error (no retry)
- A missing original fails the job with an unrecoverable `SOURCE_MISSING` error (no retry)
- A 0.4 s video still gets a thumbnail (frame taken at `t = 0.2 s`)
- A transient storage or ffmpeg network error fails the attempt with a retryable error

---

### SI-03.14 — Terminal Failure Handling and Configurable Worker Concurrency

**Description:** Record the terminal `processing → failed` state with the right `failure_reason` once a job fails for good, and apply the env-configured worker concurrency that the static `@Processor` options cannot read.

**Technical actions:**

1. Add `VideoLifecycleService.markProcessingFailed(id, reason: 'INVALID_MEDIA' | 'THUMBNAIL_FAILED' | 'SOURCE_MISSING' | 'PROCESSING_FAILED'): Promise<boolean>` = guarded `UPDATE videos SET status = 'failed', failure_reason = :reason WHERE id = :id AND status = 'processing'` (per `phase-03-videos/TD-12` AMB-1 revision)
2. Add `VideoProcessor.onFailed(job, error)` with `@OnWorkerEvent('failed')` — returns without writing when `job` is `undefined` or `job.data.videoId` is not a non-empty string; acts only when `error` is an `UnrecoverableError` (`instanceof` or `error.name === 'UnrecoverableError'`) or `job.attemptsMade >= job.opts.attempts`; reason = `error.reason` for a `VideoProcessingFailure`, otherwise `PROCESSING_FAILED`; wraps the write in try/catch and logs (never throws — background-task exception in `nestjs-services.md`) (per `phase-03-videos/TD-12` AMB-1/AMB-6/AMB-10 revisions)
3. Implement `OnApplicationBootstrap` on `VideoProcessor` — `this.worker.concurrency = videoConfig.workerConcurrency` (`VIDEO_WORKER_CONCURRENCY`); the `WorkerHost.worker` getter is available from `onApplicationBootstrap` (context7 `/nestjs/bull`) and BullMQ supports changing `worker.concurrency` at runtime (context7 `/taskforcesh/bullmq/v6.5.3`, Workers → Concurrency) (validation note 3; per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit (mock service/lifecycle/config, stub `worker`): `job` undefined / missing / empty `videoId` → no write; non-final attempt → no write; final attempt → `PROCESSING_FAILED`; `UnrecoverableError` by name only → handled; `VideoProcessingFailure` → its reason; lifecycle throwing → logged, not rethrown; `onApplicationBootstrap` sets `worker.concurrency` to the configured value | `src/video-worker/video.processor.spec.ts` |
| `VideoProcessor` (with `VideoWorkerModule`) | Integration (real `redis` + DB + `minio`, in-process worker, `bull-test` prefix): enqueue a job for a `processing` row whose original is random bytes → row becomes `failed`/`INVALID_MEDIA`; job for a row without an original → `failed`/`SOURCE_MISSING`; valid MP4 → `ready` | `src/video-worker/video.processor.integration-spec.ts` |
| `VideoLifecycleService.markProcessingFailed` | Integration (existing suite, extended): only from `processing` | `src/videos/video-lifecycle.service.integration-spec.ts` |

**Dependencies:** SI-03.13 (processor and processing service)

**Acceptance criteria:**

- A queued job for a `processing` video whose original is not a video ends with the row `failed`/`INVALID_MEDIA` after a single attempt
- A queued job for a `processing` video without an original ends with the row `failed`/`SOURCE_MISSING`
- A job that fails its third (last) attempt with a transient error leaves the row `failed`/`PROCESSING_FAILED`; a failed attempt that is not the last leaves it `processing`
- A `failed` event without a job or without `videoId` writes nothing (other `processing` rows stay untouched)
- With `VIDEO_WORKER_CONCURRENCY=2` the `video-processing` worker runs with concurrency 2; without the variable it runs with 1

---

### SI-03.15 — Maintenance Sweeper: Stuck Processing Reconciliation and Draft Expiry

**Description:** Run a scheduled sweep on the dedicated `video-maintenance` queue that reconciles videos stuck in `processing` (dual-write gap, stalled or lost jobs) and expires abandoned drafts, keeping the `videos` table truthful and storage bounded.

**Technical actions:**

1. Add to `VideoLifecycleService`: `findStuckProcessing(olderThanMs)` (`status = 'processing' AND processing_started_at < now() - :ms * interval '1 millisecond'`) and `findExpiredDrafts(olderThanMs)` (`status = 'draft' AND created_at < now() - :ms * interval '1 millisecond'`) — thresholds computed in SQL so the DB clock is the only clock (`created_at` is `timestamp`, `processing_started_at` is `timestamptz`) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-13`)
2. Create `src/video-worker/video-sweeper.service.ts` — `VideoSweeperService.sweep()` runs both branches, each row isolated with per-row catch-and-log (background-task exception): (a) stuck processing → `VideoProcessingQueue.getJobState`: `'missing'`/`'unknown'` → `enqueue`; `'failed'` → `markProcessingFailed(id, 'PROCESSING_FAILED')`; `'completed'` → `removeJob` + `enqueue`; `waiting`/`delayed`/`prioritized`/`active`/`waiting-children` → leave; (b) expired draft → `abortMultipartUpload` (`NoSuchUpload` tolerated) → `deleteObject(originalKey)` → `failDraft(id, 'UPLOAD_EXPIRED')`; any other storage error skips that row until the next tick (per `phase-03-videos/TD-13` AMB-1 revision, `phase-03-videos/TD-04` AMB-6 revision)
3. Create `src/video-worker/video-maintenance.processor.ts` — `VideoMaintenanceProcessor extends WorkerHost`, `@Processor(VIDEO_MAINTENANCE_QUEUE, { concurrency: 1 })`, `process()` delegates to `sweep()`; no `failed` handler (per `phase-03-videos/TD-04`, `phase-03-videos/TD-12` AMB-6 revision)
4. Create `src/video-worker/video-sweeper.scheduler.ts` — `VideoSweeperScheduler` (`@InjectQueue(VIDEO_MAINTENANCE_QUEUE)`) implementing `onApplicationBootstrap` → `queue.upsertJobScheduler(VIDEO_SWEEPER_SCHEDULER_ID, { every: videoConfig.sweeperIntervalMs }, { name: VIDEO_SWEEP_JOB, data: {} })`; register the service, processor and scheduler in `VideoWorkerModule` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-13` AMB-6 revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoSweeperService` | Unit (mock lifecycle/queue/storage): branch table (a) for every job state; (b) abort → delete → `failDraft` order; a storage error on one draft skips it and the next draft is still processed | `src/video-worker/video-sweeper.service.spec.ts` |
| `VideoSweeperService` | Integration (real DB + `redis` + `minio`; ages set by SQL `UPDATE`): stuck row without a job → job re-added; with a retained failed job → `failed`/`PROCESSING_FAILED`, no re-add; expired draft with a live multipart upload → upload aborted, original absent, `failed`/`UPLOAD_EXPIRED`; fresh draft and fresh `processing` row untouched | `src/video-worker/video-sweeper.service.integration-spec.ts` |
| `VideoSweeperScheduler` | Integration (real `redis`): after bootstrap, `getJobScheduler('video-sweeper')` exists with `every` = configured interval; bootstrapping twice leaves exactly one scheduler | `src/video-worker/video-sweeper.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.14 (`markProcessingFailed`), SI-03.11 (worker module, maintenance queue)

**Acceptance criteria:**

- A `processing` video older than `VIDEO_PROCESSING_STUCK_AFTER_MS` with no job gets a `process` job (`jobId = videoId`) after a sweep
- A stuck video whose retained job is `failed` becomes `failed`/`PROCESSING_FAILED` and is not re-enqueued
- A stuck video whose job is `completed` gets its job removed and re-added; a stuck video whose job is `waiting` or `active` is left unchanged
- A `draft` older than `VIDEO_UPLOAD_EXPIRE_AFTER_MS` has its multipart upload aborted and `videos/{id}/original` deleted, and becomes `failed`/`UPLOAD_EXPIRED` with `upload_id = NULL`
- A `draft` younger than the threshold is untouched by the sweep
- A storage error while expiring one draft does not prevent the other expired drafts in the same sweep from being processed
- After the worker boots, `video-maintenance` holds exactly one `video-sweeper` Job Scheduler repeating every `VIDEO_SWEEPER_INTERVAL_MS`

---

### SI-03.16 — End-to-End Video Pipeline Verification

**Description:** Prove the whole phase over HTTP against the real Compose infrastructure — upload → `processing` → `ready` → stream/download, plus the invalid-media path — with the API and the worker running in the test process, and confirm the Compose `video-worker` processes a real upload.

**Technical actions:**

1. Create `test/helpers/authenticated-user.ts` — registers a user through `POST /auth/register`, confirms it (`is_confirmed = true` via the repository, as `test/auth.e2e-spec.ts` already reaches the DB), logs in with `POST /auth/login` and returns the access token
2. Create `test/videos-pipeline.e2e-spec.ts` — boots the API (`AppModule` with the same global pipe/filters as `test/auth.e2e-spec.ts`) and an in-process `VideoWorkerModule` application context in the same Jest process (`QUEUE_PREFIX=bull-test` from the setup file, so the Compose `video-worker` never takes these jobs); cleans `videos` and auth tables before each test; closes both on `afterAll`
3. Scenario "valid video": `POST /videos` with a generated MP4 (`src/test/video-fixtures.ts`) → `POST /videos/:id/upload/parts` → `fetch` PUT → `POST /videos/:id/upload/complete` → poll `GET /videos/:id` (≤ 60 s) until `ready` → assert metadata → `GET /videos/:slug/stream` → `Range` request on `Location` → `GET /videos/:slug/download` → `Content-Disposition` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-11`, `phase-03-videos/TD-12`)
4. Scenario "invalid media": same upload flow with random bytes declared as `video/mp4` → poll until `failed` with `failureReason: 'INVALID_MEDIA'`; stream/download of that slug → `404`. Scenario "unique URLs": two uploads → distinct slugs

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Video pipeline (API + worker + Redis + Silo + Postgres) | E2E (supertest + in-process worker): valid video to `ready` and playback, invalid media to `failed`, unique slugs | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.10 (stream/download), SI-03.14 (terminal failure handling)

**Acceptance criteria:**

- A video uploaded through the API in parts goes `draft` → `processing` → `ready` as observed through `GET /videos/:id`, ending with non-null `durationMs`, `width`, `height` and `videoCodec`
- For that `ready` video, `GET /videos/:slug/stream` redirects to a URL that answers a `Range` request with `206 Partial Content`
- For that `ready` video, `GET /videos/:slug/download` redirects to a URL that answers with `Content-Disposition: attachment`
- A non-video file uploaded the same way ends `failed` with `failureReason: "INVALID_MEDIA"`, and its stream route returns `404`
- Two uploads receive two different slugs
- With the Compose stack up (`docker compose up -d`) and the API started (`npm run start:dev`), a video uploaded with `curl` against `localhost:3000` (presigned URLs on `localhost:9000`) is processed to `ready` by the `video-worker` container

---

## Technical Specifications

### Data Model

#### Video

Table `videos` (new, migration `CreateVideos`). Entity `src/videos/entities/video.entity.ts`.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | Generated in the service with `randomUUID()` (`node:crypto`) **before** the insert, because the storage key `videos/{id}/original` is needed for `CreateMultipartUpload` (per `phase-03-videos/TD-05`). `@PrimaryColumn('uuid')` |
| channel_id | uuid | FK → channels.id, not null | Owner channel (the caller's channel, per `phase-03-videos/TD-03`) |
| slug | varchar(11) | unique, not null | `randomBytes(8).toString('base64url')` — 11 chars; unique constraint + retry on collision (per `phase-03-videos/TD-10`) |
| title | varchar(100) | not null | Trimmed, 1–100 Unicode code points; default derived from `filename` (per `phase-03-videos/TD-03` IC-2 revision) |
| status | enum `videos_status_enum` | not null, default `'draft'`, values `'draft'`, `'processing'`, `'ready'`, `'failed'` | Processing lifecycle only — Phase 04 adds a separate publication field (per `phase-03-videos/TD-12` AMB-4 revision) |
| failure_reason | varchar(32) | nullable | TS union `VideoFailureReason`, not a PG enum: `UPLOAD_EXPIRED`, `UPLOAD_ABORTED`, `UPLOAD_SIZE_MISMATCH`, `INVALID_MEDIA`, `THUMBNAIL_FAILED`, `SOURCE_MISSING`, `PROCESSING_FAILED` (per `phase-03-videos/TD-12`) |
| original_filename | varchar(255) | not null | Declared `filename`, stored unchanged (per `phase-03-videos/TD-09` AMB-2 revision) |
| content_type | varchar(127) | not null | Declared `video/*` content type |
| size_bytes | bigint | not null | Declared size, re-verified with `HeadObject` at completion; mapped to `number` with a column transformer (≤ 10 GiB < 2^53) |
| upload_id | text | nullable | S3 multipart `UploadId`; set at start, cleared (`NULL`) on `draft → processing`, abort and expiry. Never exposed over HTTP |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg`, set on `processing → ready` |
| duration_ms | integer | nullable | `round(format.duration × 1000)` from ffprobe; set on `ready` |
| width | integer | nullable | Coded width of the first `codec_type = video` stream; set on `ready` |
| height | integer | nullable | Coded height of that stream; set on `ready` |
| video_codec | varchar(32) | nullable | That stream's `codec_name`; set on `ready` |
| processing_started_at | timestamptz | nullable | Set on `draft → processing`; read by the sweeper's stuck-processing scan (per `phase-03-videos/TD-13` AMB-1 revision) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` (same as `users`/`channels`) |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel → Video (one-to-many, inverse side `channel.videos` — added to `channel.entity.ts`, no column change)
**Indexes:** `(slug)` — unique; `(channel_id)` — FK; `(status, created_at)` — sweeper draft-expiry scan; `(status, processing_started_at)` — sweeper stuck-processing scan

**Status transitions** (every write is a guarded `UPDATE … WHERE id = :id AND status = :expected`; zero affected rows means another actor won the race):

| From | To | Actor | Side effects on the row |
|------|----|-------|-------------------------|
| — | `draft` | `POST /videos` | `upload_id` set |
| `draft` | `processing` | `POST /videos/:id/upload/complete` | `upload_id = NULL`, `processing_started_at = now()` |
| `draft` | `failed` | `POST /videos/:id/upload/complete` (size mismatch) | `failure_reason = 'UPLOAD_SIZE_MISMATCH'`, `upload_id = NULL` |
| `draft` | `failed` | `DELETE /videos/:id/upload` | `failure_reason = 'UPLOAD_ABORTED'`, `upload_id = NULL` |
| `draft` | `failed` | sweeper draft expiry | `failure_reason = 'UPLOAD_EXPIRED'`, `upload_id = NULL` |
| `processing` | `ready` | `video-processing` job | `duration_ms`, `width`, `height`, `video_codec`, `thumbnail_key` set |
| `processing` | `failed` | worker `failed` event / sweeper | `failure_reason` ∈ `INVALID_MEDIA`, `THUMBNAIL_FAILED`, `SOURCE_MISSING`, `PROCESSING_FAILED` |

**Storage layout** (single private bucket `S3_BUCKET`, per `phase-03-videos/TD-05`): `videos/{videoId}/original` (object `Content-Type` = declared `content_type`, set at `CreateMultipartUpload`) and `videos/{videoId}/thumbnail.jpg` (`image/jpeg`). Key builders live in `src/videos/video-storage-keys.ts`.

**Configuration** (phase-01 conventions — `registerAs` namespaces + Joi; hosts are Compose service names, never `localhost`):

| Namespace (file) | Env var | Joi rule / default | Consumer |
|------------------|---------|--------------------|----------|
| `redis` (`src/config/redis.config.ts`) | `REDIS_HOST` | string, default `redis` | `BullModule.forRootAsync` connection |
| `redis` | `REDIS_PORT` | port, default `6379` | same |
| `redis` | `QUEUE_PREFIX` | string, default `bull` | BullMQ key prefix (shared by queues and workers); the Jest setup file sets `bull-test` so in-process test workers never share keys with the Compose `video-worker` |
| `storage` (`src/config/storage.config.ts`) | `S3_ENDPOINT` | uri, required (`http://minio:9000`) | internal `S3Client` — every storage operation (per `phase-03-videos/TD-06`) |
| `storage` | `S3_PUBLIC_ENDPOINT` | uri, required (`http://localhost:9000` in `.env.example` — host-facing URL handed to clients outside Docker; the Jest setup file overrides it with `S3_ENDPOINT`) | presign-only `S3Client` (per `phase-03-videos/TD-06`) |
| `storage` | `S3_REGION` | string, default `us-east-1` | both clients |
| `storage` | `S3_ACCESS_KEY_ID` | string, required | both clients; Compose `minio` reuses it as `MINIO_ROOT_USER` |
| `storage` | `S3_SECRET_ACCESS_KEY` | string min 8, required | both clients; Compose `minio` reuses it as `MINIO_ROOT_PASSWORD` |
| `storage` | `S3_BUCKET` | string, default `streamtube-videos` | storage service; Compose `minio-init` creates it |
| `video` (`src/config/video.config.ts`) | `VIDEO_WORKER_CONCURRENCY` | integer ≥ 1, default `1` | applied to the `video-processing` worker in `onApplicationBootstrap` (per `phase-03-videos/TD-08`) |
| `video` | `VIDEO_SWEEPER_INTERVAL_MS` | integer ≥ 1000, default `900000` | `upsertJobScheduler('video-sweeper', { every })` (per `phase-03-videos/TD-04`) |
| `video` | `VIDEO_PROCESSING_STUCK_AFTER_MS` | integer ≥ 1000, default `1800000` | sweeper stuck-processing scan (per `phase-03-videos/TD-13`) |
| `video` | `VIDEO_UPLOAD_EXPIRE_AFTER_MS` | integer ≥ 1000, default `86400000` | sweeper draft expiry (per `phase-03-videos/TD-04`) |

Fixed contract values are code constants, not env (`src/videos/video.constants.ts`): `VIDEO_MAX_SIZE_BYTES = 10 × 1024³`, `VIDEO_PART_SIZE_BYTES = 64 × 1024²`, `VIDEO_MAX_PART_COUNT = 160`, `UPLOAD_PART_URL_TTL_SECONDS = 3600`, `PLAYBACK_URL_TTL_SECONDS = 3600`, `WORKER_SOURCE_URL_TTL_SECONDS = 900`, `MEDIA_COMMAND_TIMEOUT_MS = 120000`, `THUMBNAIL_MAX_BUFFER_BYTES = 10 × 1024²`.

**Compose services** (`nestjs-project/compose.yaml`):

| Service | Image / build | Purpose | Healthcheck / readiness |
|---------|---------------|---------|-------------------------|
| `redis` | `redis:8.10.3-alpine`, `command: ["redis-server", "--maxmemory-policy", "noeviction"]` | BullMQ backend (per `phase-03-videos/TD-01`) | `redis-cli ping` |
| `minio` | `pgsty/silo:RELEASE.2026-10-26T00-00-00Z`, `command: server /data --console-address ":9001"`, ports `9000`/`9001`, named volume `minio-data` | S3-compatible object storage (per `phase-03-videos/TD-07`) | `curl -f http://localhost:9000/minio/health/live` (runs inside the `minio` container itself; the image ships `curl` and `mc`, verified 2026-11-07) |
| `minio-init` | `pgsty/mc:RELEASE.2026-10-26T00-00-00Z`, one-shot (`restart: "no"`) | `mc alias set local http://minio:9000 …` then `mc mb --ignore-existing local/${S3_BUCKET}` | depends on `minio: service_healthy`; consumers wait on `service_completed_successfully` |
| `video-worker` | same build as `nestjs-api` (`Dockerfile.dev`, now with apt `ffmpeg`), `command: npm run start:worker:dev`, same `.:/home/node/app` volume, no ports | Runs `src/worker.ts` — consumes `video-processing` and `video-maintenance` (per `phase-03-videos/TD-08`) | depends on `db` healthy, `redis` healthy, `minio-init` completed; `restart: unless-stopped` |
| `nestjs-api` | unchanged build | API | now also depends on `redis` healthy and `minio-init` completed |

---

### API Contracts

All routes live in `VideosController` (`@ApiTags('videos')`, `@Controller('videos')`, `@SkipThrottle()` — the `ThrottlerGuard` is registered as a global `APP_GUARD` by `AuthModule`, and `phase-02-auth/TD-08` scopes rate limiting to auth endpoints; `AppController` already opts out the same way). Errors use the `{ statusCode, error, message }` envelope (`phase-02-auth/TD-07`). `:id` is validated with `ParseUUIDPipe` → `400` `VALIDATION_ERROR` on malformed input (per `phase-03-videos/TD-03` AMB-9 revision). Owner-scoped routes answer `404 VIDEO_NOT_FOUND` both for a missing video and for one not owned by the caller's channel. Authenticated routes return `401` without a valid access token (global `JwtAuthGuard`).

#### POST /videos (SI-03.6)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- title: string, optional — trimmed; 1–100 Unicode code points after trimming. When omitted: `filename` minus its last extension, trimmed, cut to 100 code points; if empty, the full `filename` trimmed and cut to 100 code points
- filename: string, required — 1–255 Unicode code points, at least one non-whitespace character; stored unchanged as `original_filename`
- size: integer, required — 1..10737418240 (10 GiB)
- contentType: string, required — matches `^video/`, max 127 characters

**Response 201:**
- id: string (uuid)
- slug: string (11 chars, base64url)
- status: `'draft'`
- partSize: integer — 67108864 (64 MiB)
- partCount: integer — `ceil(size / partSize)`

**Error responses:**
- 400 VALIDATION_ERROR: when the body fails validation
- 401: when the access token is missing or invalid

---

#### GET /videos/:id (SI-03.6)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:** (any status)
- id: string (uuid)
- slug: string
- title: string
- status: `'draft' | 'processing' | 'ready' | 'failed'`
- failureReason: string | null
- originalFilename: string
- contentType: string
- sizeBytes: number
- durationMs: number | null
- width: number | null
- height: number | null
- videoCodec: string | null
- createdAt: string (ISO 8601)
- updatedAt: string (ISO 8601)

`upload_id`, `thumbnail_key` and `processing_started_at` are not exposed; there is no thumbnail URL.

**Error responses:**
- 400 VALIDATION_ERROR: when `:id` is not a UUID
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller's channel

---

#### POST /videos/:id/upload/parts (SI-03.7)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — 1..160 entries, unique, each ≥ 1 (DTO); each ≤ the video's `partCount` (service)

**Response 200:**
- parts: `[{ partNumber: integer, url: string }]` — presigned `UploadPart` URLs, signed with the public client, TTL 3600 s
- expiresAt: string (ISO 8601) — signing time + 3600 s

**Error responses:**
- 400 VALIDATION_ERROR: when the body fails validation or `:id` is not a UUID
- 400 UPLOAD_PARTS_INVALID: when a part number is greater than the video's `partCount`
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller
- 409 VIDEO_UPLOAD_NOT_ACTIVE: when the video is not `draft`

---

#### GET /videos/:id/upload/parts (SI-03.7)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- parts: `[{ partNumber: integer, etag: string, size: integer }]` — from `ListParts`, paginated internally (`IsTruncated` / `NextPartNumberMarker`), ascending

**Error responses:**
- 400 VALIDATION_ERROR: when `:id` is not a UUID
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller
- 409 VIDEO_UPLOAD_NOT_ACTIVE: when the video is not `draft`, or `ListParts` answers `NoSuchUpload` for a `draft` row

---

#### DELETE /videos/:id/upload (SI-03.8)

**Request headers:**
- Authorization: Bearer {access_token}

**Effect:** `AbortMultipartUpload` (`NoSuchUpload` tolerated) → `DeleteObject` on `videos/{id}/original` (idempotent) → guarded `UPDATE videos SET status = 'failed', failure_reason = 'UPLOAD_ABORTED', upload_id = NULL WHERE id = :id AND status = 'draft'`.

**Response 204:** No content.

**Error responses:**
- 400 VALIDATION_ERROR: when `:id` is not a UUID
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller
- 409 VIDEO_UPLOAD_NOT_ACTIVE: when the video is not `draft`, **or** the guarded update matched no row because a concurrent `complete` moved it first (validation note 2)

---

#### POST /videos/:id/upload/complete (SI-03.9)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- parts: `[{ partNumber: integer ≥ 1, etag: string (non-empty) }]`, required — 1..160 entries (DTO); exactly `partCount` entries in strictly ascending `partNumber` order (service)

**Effect** (on a `draft` row): `CompleteMultipartUpload` → `HeadObject` → size check → guarded `draft → processing` (`upload_id = NULL`, `processing_started_at = now()`) and commit → enqueue `process` with `jobId = videoId` (per `phase-03-videos/TD-13`). On `NoSuchUpload` from `CompleteMultipartUpload`, `HeadObject` decides: object present → continue from the size check; `NotFound` → `409` (row stays `draft`) (per `phase-03-videos/TD-03` AMB-7 revision).

**Response 200:**
- id: string (uuid)
- slug: string
- status: `'processing'`

A repeated call on a `processing` video returns the same `200` and re-adds the deterministic job (idempotent; BullMQ ignores the duplicate `jobId`).

**Error responses:**
- 400 VALIDATION_ERROR: when the body fails validation or `:id` is not a UUID
- 400 UPLOAD_PARTS_INVALID: when the parts are not exactly `partCount` entries in ascending order, or storage answers `InvalidPart` / `InvalidPartOrder` (the video stays `draft`; the client can resume)
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller
- 409 VIDEO_UPLOAD_NOT_ACTIVE: when the video is `ready` or `failed`, or `NoSuchUpload` + `HeadObject` `NotFound` on a `draft` row
- 422 UPLOAD_SIZE_MISMATCH: when the stored object size differs from the declared `size` (object deleted, video → `failed` / `UPLOAD_SIZE_MISMATCH`)

---

#### GET /videos/:slug/stream (SI-03.10)

**Request headers:** none (public)

**Response 302:**
- Location: presigned `GetObject` URL for `videos/{id}/original`, signed with the public client, `expiresIn: 3600`, no response overrides (storage answers `Range` with `206 Partial Content`)
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug is unknown **or** the video is not `ready` (`draft`, `processing`, `failed`) — same code, state not revealed

---

#### GET /videos/:slug/download (SI-03.10)

**Request headers:** none (public)

**Response 302:**
- Location: presigned `GetObject` URL (public client, `expiresIn: 3600`) with `ResponseContentDisposition = attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`
- Cache-Control: no-store

Filename = sanitized `title` + original extension. Extension: last `.ext` of `original_filename`, lower-cased, kept only if it matches `^[a-z0-9]{1,10}$`. Sanitizing: remove control characters and `/ \ : * ? " < > |`, collapse whitespace, trim spaces and trailing dots, `video` if empty. `<encoded>` = `encodeURIComponent(name)` plus `'`, `(`, `)`, `*` percent-encoded; `<ascii>` = name with each non-ASCII character replaced by `_` (per `phase-03-videos/TD-11` AMB-8 revision).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug is unknown or the video is not `ready`

---

#### Validation Rules — videos

| Field | Rule | Implementation |
|-------|------|----------------|
| `title` | optional; trimmed; 1–100 Unicode code points | `@IsOptional()`, `@Transform` trim, `@IsString()`, `@IsNotEmpty()`, `@MaxCodePoints(100)` |
| `filename` | 1–255 Unicode code points, ≥ 1 non-whitespace character | `@IsString()`, `@Matches(/\S/)`, `@MaxCodePoints(255)` |
| `size` | integer 1..10737418240 | `@IsInt()`, `@Min(1)`, `@Max(VIDEO_MAX_SIZE_BYTES)` |
| `contentType` | `^video/`, ≤ 127 characters | `@IsString()`, `@Matches(/^video\//)`, `@MaxLength(127)` |
| `partNumbers` | 1..160 unique integers ≥ 1 | `@IsArray()`, `@ArrayMinSize(1)`, `@ArrayMaxSize(VIDEO_MAX_PART_COUNT)`, `@ArrayUnique()`, `@IsInt({ each: true })`, `@Min(1, { each: true })` |
| `parts` | 1..160 `{ partNumber, etag }` | `@IsArray()`, `@ArrayMinSize(1)`, `@ArrayMaxSize(VIDEO_MAX_PART_COUNT)`, `@ValidateNested({ each: true })`, `@Type(() => CompletedPartDto)`; `partNumber` `@IsInt() @Min(1)`, `etag` `@IsString() @IsNotEmpty()` |
| `:id` | UUID | `ParseUUIDPipe` |

**Code-point length (validation note 4):** `title` and `filename` lengths are counted in Unicode code points — `Array.from(value).length` — by a custom class-validator decorator `@MaxCodePoints(n)` (`src/common/validators/max-code-points.validator.ts`), matching how PostgreSQL counts `varchar(n)` and how the default title is cut (`truncateCodePoints`, `Array.from(s).slice(0, n).join('')`). class-validator's `@MaxLength` (UTF-16 units) is not used for these fields.

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner | Notes |
|----------|--------|---------------|-------|-------|
| POST /videos | | ✓ | — | Draft is created in the caller's channel (`ChannelsService.findByUserId(sub)`) |
| GET /videos/:id | | | ✓ | Non-owner → `404 VIDEO_NOT_FOUND`; any status |
| POST /videos/:id/upload/parts | | | ✓ | Non-owner → `404`; `draft` only |
| GET /videos/:id/upload/parts | | | ✓ | Non-owner → `404`; `draft` only |
| POST /videos/:id/upload/complete | | | ✓ | Non-owner → `404` |
| DELETE /videos/:id/upload | | | ✓ | Non-owner → `404`; `draft` only |
| GET /videos/:slug/stream | ✓ | ✓ | ✓ | `@Public()`; `ready` only, otherwise `404` (per `phase-03-videos/TD-14`) |
| GET /videos/:slug/download | ✓ | ✓ | ✓ | `@Public()`; `ready` only, otherwise `404` (per `phase-03-videos/TD-14`) |

Ownership is resolved in the service: the video's `channel_id` must equal the caller's channel id (`channels.user_id = sub`). Phase 04 tightens stream/download to also require publication without changing the route shape (per `phase-03-videos/TD-14` AMB-4 revision).

---

### Error Catalog

Error response format inherited from `phase-02-auth` (`{ statusCode, error, message }`, `VALIDATION_ERROR` with a message array for validation). New domain exceptions live in `src/videos/videos.exceptions.ts` and extend `DomainException`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Owner-scoped route with an unknown id or a video of another channel; stream/download with an unknown slug or a non-`ready` video |
| VIDEO_UPLOAD_NOT_ACTIVE | 409 | Video has no active upload session | Parts/list/abort on a non-`draft` video; `complete` on `ready`/`failed`; `NoSuchUpload` on a `draft` with no stored object (`complete`) or on `ListParts`; abort whose guarded update matched no row |
| UPLOAD_PARTS_INVALID | 400 | Upload parts are invalid | Part number above `partCount`; `complete` parts not exactly `partCount` in ascending order; storage `InvalidPart` / `InvalidPartOrder` |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded size does not match the declared size | `HeadObject` `ContentLength` ≠ `size_bytes` at completion |

**Persisted `failure_reason` values** (not HTTP errors; read via `GET /videos/:id` → `failureReason`):

| failure_reason | Written by | Meaning |
|----------------|-----------|---------|
| UPLOAD_ABORTED | `DELETE /videos/:id/upload` | User aborted the upload |
| UPLOAD_EXPIRED | sweeper draft expiry | Draft older than `VIDEO_UPLOAD_EXPIRE_AFTER_MS` |
| UPLOAD_SIZE_MISMATCH | `complete` | Stored size ≠ declared size |
| INVALID_MEDIA | worker (`UnrecoverableError`) | ffprobe non-zero exit with non-transient stderr, unparsable JSON, no video stream, or missing/non-positive duration |
| THUMBNAIL_FAILED | worker (`UnrecoverableError`) | No frame at `t` nor at `t = 0` |
| SOURCE_MISSING | worker (`UnrecoverableError`) | `HeadObject` `NotFound` on the original before ffprobe |
| PROCESSING_FAILED | worker `failed` handler / sweeper | Retries exhausted (incl. transient storage/ffprobe/ffmpeg errors), stalled job, or retained failed job found by the sweeper |

---

### Events/Messages

Shared queue contracts live in `src/videos/video-queue.constants.ts` and are imported by **both** the API producer and the worker (validation note 1):

```ts
export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESS_JOB = 'process';
export const VIDEO_MAINTENANCE_QUEUE = 'video-maintenance';
export const VIDEO_SWEEP_JOB = 'sweep';
export const VIDEO_SWEEPER_SCHEDULER_ID = 'video-sweeper';
export interface VideoProcessingJobData { videoId: string }
export const VIDEO_PROCESSING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10000 },
  removeOnComplete: true,
  removeOnFail: { count: 1000 },
} satisfies JobsOptions;
export const VIDEO_MAINTENANCE_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { count: 100 },
} satisfies JobsOptions;
```

`VIDEO_PROCESSING_JOB_OPTIONS` is the `defaultJobOptions` of the single `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, … })` declared in `VideosModule`; the worker imports `VideosModule`, so the API and the worker register `video-processing` from the same declaration. Every BullMQ key uses `QUEUE_PREFIX`.

#### video-processing / process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job id:** `videoId` (dedupe — BullMQ ignores `add` while a job with that id exists, including retained completed/failed jobs)
**Options:** `VIDEO_PROCESSING_JOB_OPTIONS` (per `phase-03-videos/TD-12`)
**Producer:** `VideoProcessingQueue.enqueue(videoId)` (`src/videos/video-processing.queue.ts`), called by `VideosService.completeUpload` after the `draft → processing` commit, and by the sweeper for re-adds (per `phase-03-videos/TD-13`)
**Consumer:** `VideoProcessor` (`@Processor('video-processing', { concurrency: 1 })`, concurrency then set from `VIDEO_WORKER_CONCURRENCY` in `onApplicationBootstrap`) → `VideoProcessingService.process(videoId)` in the `video-worker` container (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`)
**Trigger:** upload completion (`POST /videos/:id/upload/complete`) and sweeper reconciliation of stuck `processing` rows
**Processing steps:** load the row (not `processing` → return, redelivery no-op) → `HeadObject` original (`NotFound` → `UnrecoverableError` `SOURCE_MISSING`) → sign internal GET (TTL 900 s, fresh each attempt) → ffprobe (`INVALID_MEDIA` rules) → thumbnail at `t = min(1 s, duration / 2)` with `t = 0` fallback (`THUMBNAIL_FAILED`) → `PutObject` `videos/{id}/thumbnail.jpg` → guarded `processing → ready` with metadata
**Delivery semantics:** at-least-once — every step is idempotent (guarded status writes, deterministic keys, `PutObject` overwrite) (per `phase-03-videos/TD-12`, `phase-03-videos/TD-13`)

#### video-processing — worker `failed` event (terminal write)

**Payload:** BullMQ `(job: Job<VideoProcessingJobData> | undefined, error: Error)`
**Producer:** BullMQ worker (`@OnWorkerEvent('failed')` on `VideoProcessor`)
**Consumer:** `VideoProcessor.onFailed` → `VideoLifecycleService.markProcessingFailed(videoId, reason)`
**Trigger:** a job attempt fails. Acts only when `job` is defined, `job.data.videoId` is a non-empty string, and (`error` is an `UnrecoverableError` — `instanceof` or `error.name === 'UnrecoverableError'` — or `job.attemptsMade >= job.opts.attempts`). Writes `failure_reason` = the error's domain code (`INVALID_MEDIA` / `THUMBNAIL_FAILED` / `SOURCE_MISSING`) or `PROCESSING_FAILED`, guarded `WHERE status = 'processing'`. Never throws; logs its own errors (per `phase-03-videos/TD-12`)
**Delivery semantics:** best-effort (in-process event) — missed cases (`job === undefined`, stalled beyond `maxStalledCount`) are reconciled by the sweeper

#### video-maintenance / sweep

**Payload:**

```json
{}
```

**Job id:** generated by the Job Scheduler `video-sweeper`
**Options:** `VIDEO_MAINTENANCE_JOB_OPTIONS` (per `phase-03-videos/TD-04`)
**Producer:** Job Scheduler — `VideoSweeperScheduler.onApplicationBootstrap` calls `upsertJobScheduler('video-sweeper', { every: VIDEO_SWEEPER_INTERVAL_MS }, { name: 'sweep', data: {} })` on `video-maintenance` at every worker boot (idempotent) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-13`)
**Consumer:** `VideoMaintenanceProcessor` (`@Processor('video-maintenance', { concurrency: 1 })`) → `VideoSweeperService.sweep()`
**Trigger:** every `VIDEO_SWEEPER_INTERVAL_MS` (default 15 min)
**Sweep branches:** (1) stuck processing — `status = 'processing' AND processing_started_at < now() - VIDEO_PROCESSING_STUCK_AFTER_MS`; per row, job state via `VideoProcessingQueue`: missing/`unknown` → re-add; `failed` → `failed`/`PROCESSING_FAILED`; `completed` → remove + re-add; `waiting`/`delayed`/`prioritized`/`active`/`waiting-children` → leave. (2) draft expiry — `status = 'draft' AND created_at < now() - VIDEO_UPLOAD_EXPIRE_AFTER_MS`; per row: `AbortMultipartUpload` (`NoSuchUpload` tolerated) → `DeleteObject` original → guarded `draft → failed`/`UPLOAD_EXPIRED`; any other storage error skips the row (logged) until the next tick
**Delivery semantics:** at-least-once, `attempts: 1` — a failed sweep is redone at the next tick

---

## Dependency Map

```
SI-03.1 (root — deps, Compose redis/minio/minio-init, config)
├── SI-03.2 — storage module (needs SDK + minio + storage config)
├── SI-03.3 — queue root + shared contracts (needs BullMQ + redis + redis config)
└── SI-03.4 — Video entity + migration (needs env/Compose so the suite stays green)

SI-03.5 (root, independent — pure naming/sizing rules)

SI-03.2 + SI-03.4 + SI-03.5
└── SI-03.6 — POST /videos, GET /videos/:id (controller + service)
    ├── SI-03.7 — part signing / resume
    ├── SI-03.8 — abort (+ VideoLifecycleService)
    └── SI-03.10 — stream / download

SI-03.3 + SI-03.7 + SI-03.8
└── SI-03.9 — complete + enqueue (VideosModule registers video-processing)

SI-03.3 + SI-03.9
└── SI-03.11 — worker runtime + video-worker Compose service (+ ffmpeg in Dockerfile.dev)
    └── SI-03.12 — media toolkit (also needs SI-03.2)
        └── SI-03.13 — processing job → ready
            └── SI-03.14 — terminal failure handling + concurrency
                └── SI-03.15 — maintenance sweeper (also needs SI-03.11)

SI-03.10 + SI-03.14
└── SI-03.16 — end-to-end pipeline verification
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4, SI-03.5 (any order) → SI-03.6 → SI-03.7, SI-03.8, SI-03.10 (any order) → SI-03.9 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14 → SI-03.15 → SI-03.16

---

## Deliverables

- [ ] SI-03.1 — Infra: Dependencies, Compose Storage/Queue Services and Configuration
- [ ] SI-03.2 — Storage Module with Internal and Presign S3 Clients
- [ ] SI-03.3 — Queue Root Module and Shared Queue Contracts
- [ ] SI-03.4 — Video Entity, Migration and VideosModule Skeleton
- [ ] SI-03.5 — Video Naming and Sizing Rules
- [ ] SI-03.6 — Start Upload and Owner Read (POST /videos, GET /videos/:id)
- [ ] SI-03.7 — Part Signing and Upload Resume (POST/GET /videos/:id/upload/parts)
- [ ] SI-03.8 — Abort Upload (DELETE /videos/:id/upload)
- [ ] SI-03.9 — Complete Upload and Enqueue Processing (POST /videos/:id/upload/complete)
- [ ] SI-03.10 — Streaming and Download by Unique Slug (GET /videos/:slug/stream, GET /videos/:slug/download)
- [ ] SI-03.11 — Infra: Video Worker Runtime and Compose Service
- [ ] SI-03.12 — Media Toolkit: ffprobe/ffmpeg Wrapper with Failure Classification
- [ ] SI-03.13 — Video Processing Job: Metadata, Thumbnail and Ready Transition
- [ ] SI-03.14 — Terminal Failure Handling and Configurable Worker Concurrency
- [ ] SI-03.15 — Maintenance Sweeper: Stuck Processing Reconciliation and Draft Expiry
- [ ] SI-03.16 — End-to-End Video Pipeline Verification

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
