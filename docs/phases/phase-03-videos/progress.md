# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 9/16 completed

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
- **Status:** completed
- **Tests:** 14 passing (`src/storage/storage.service.integration-spec.ts` 13 against the real `minio` service, `src/storage/storage.module.spec.ts` 1); full suites 25 suites / 173 tests, e2e 3 suites / 52 tests
- **Observations:**
  - `presignUploadPart` / `presignGetObject` are `async` (project rule: every I/O method is `async` with an explicit `Promise<T>`), although signing is offline.
  - The public-host AC can't be seen with the test env alone, because the Jest setup file sets `S3_PUBLIC_ENDPOINT = S3_ENDPOINT`. The spec builds a second testing module whose `storageConfig.KEY` points the public endpoint at the unresolvable `http://storage.public.test:9000` (signing is offline). It asserts that part URLs and `client: 'public'` GET URLs carry that host, and `client: 'internal'` GET URLs carry the `S3_ENDPOINT` host.
  - Tests added beyond the plan's list: `NoSuchUpload` on `completeMultipartUpload` → `UploadSessionNotFoundError`; abort of an already completed upload resolves; `responseContentDisposition` comes back as the `Content-Disposition` header; deleting a missing key resolves.
  - Checked in the container: with the SDK default `WHEN_SUPPORTED`, a presigned `UploadPart` URL carries `x-amz-checksum-crc32` + `x-amz-sdk-checksum-algorithm`; with `WHEN_REQUIRED` it carries none. So the spec's no-checksum assertion can actually fail.
  - `InvalidPart` / `InvalidPartOrder` are not modelled exception classes in `@aws-sdk/client-s3` 3.1164.0 (only `NoSuchUpload` / `NotFound` are), so all matching is by `err.name`, as library-refs.md says. Mapped errors keep the SDK error as `cause`.
  - `StorageModule` relies on the global `ConfigModule` (same pattern as `MailModule`). It is not imported into `AppModule` here; `VideosModule` imports it from SI-03.6.
  - Tests ran directly in the container, not through a test sub-agent (the agent runtime doesn't allow nested agent spawns unless the user asks).

### SI-03.3 — Queue Root Module and Shared Queue Contracts
- **Status:** completed
- **Tests:** 5 passing (`src/queue/queue.module.integration-spec.ts`, against the real `redis` service); full suites 26 suites / 178 tests, e2e 3 suites / 52 tests
- **Observations:**
  - `@nestjs/bullmq` 12.0.1 and `@nestjs/bull-shared` 12.0.1 are ESM-only (`"type": "module"`). Node 25 `require()`s them at runtime and TS 5.9 `nodenext` accepts the import, so `tsc`, `nest build` and `node dist/main` work unchanged. Jest's CJS runtime can't load them, so both Jest configs (`package.json` `jest` and `test/jest-e2e.json`) gained `transformIgnorePatterns: ["/node_modules/(?!(@nestjs/bullmq|@nestjs/bull-shared)/)"]`. ts-jest 29.4.6 already transpiles JS from `node_modules` to CommonJS (no `allowJs` needed). These config edits weren't in the plan's technical actions; without them no test can import `@nestjs/bullmq`.
  - Prefix on `@Processor` workers (checked with context7 `/nestjs/bull` and in the installed 12.0.1 source, `BullExplorer.handleProcessor`): the worker options are `{ connection, sharedConnection, prefix, telemetry, ...decoratorOptions }`, taken from the registered queue's resolved options (shared root config merged with the queue options) or, if no queue is registered, from the shared root config. The root `prefix` therefore reaches `@Processor` workers unless the decorator overrides it.
  - BullMQ 6 removed `queue.client`; the raw connection is `queue.getBackend().client` (an ioredis wrapper that still exposes `status`). The spec inspects keys with its own `ioredis` client (closed with `quit()` in `afterAll`) and checks connection release through `getBackend().client.status === 'end'` after `module.close()`.
  - A duplicate `add` with an existing `jobId` resolves to a `Job` object with the same `id`, but built from the second call's arguments; the stored job keeps the first payload. The spec checks the same id, an unchanged waiting count, and the stored data.
  - `BullModule.forRootAsync` only stores the shared config. No Redis connection opens until a queue is registered (VideosModule, SI-03.9), so the AppModule e2e tests and `openapi:export` don't need extra teardown. Boot check: `node dist/main` logs `BullModule dependencies initialized` and `GET /` returns 200.
  - The constants follow the plan's `satisfies JobsOptions` form verbatim, without the `as const` that `.claude/rules/nestjs-common-conventions.md` asks for. String constants are already literal types.
  - Tests ran directly in the container, not through a test sub-agent (nested agent spawns are not allowed in this runtime).

### SI-03.4 — Video Entity, Migration and VideosModule Skeleton
- **Status:** completed
- **Tests:** 11 passing in the SI's files (`src/videos/entities/video.entity.integration-spec.ts` 8, `src/videos/videos.module.spec.ts` 1, `src/database/migrations.integration-spec.ts` 2 updated); full suites 28 suites / 187 tests, e2e 3 suites / 52 tests
- **Observations:**
  - The generated migration is `1794056016213-CreateVideos.ts`. Its SQL matches the plan: `videos_status_enum`, unique `slug`, FK `channel_id → channels.id`, indexes `(channel_id)`, `(status, created_at)` and `(status, processing_started_at)`; `down()` drops the FK, the indexes, the table, then the enum. `npm run lint --fix` reformatted it to Prettier style (same as the existing migrations); the SQL is unchanged.
  - Postgres doesn't index FK columns on its own, so `channel_id` has an explicit `@Index()` to produce the plan's `(channel_id)` index. The enum uses TypeORM's default type name (`videos_status_enum`), so there's no `enumName`.
  - The `size_bytes` transformer maps `pg`'s bigint string to a `number` on read (`null` stays `null`) and passes values through on write.
  - The migration revert test now asserts that `videos` and `videos_status_enum` are gone and that the token tables are still there (the previous last migration, `CreateAuthTokens`, is untouched).
  - Tests added beyond the plan's list: a full round-trip of the media/failure/`processing_started_at` columns, and loading the `channel` relation and the inverse `channel.videos`. Constraint tests check the Postgres error codes (`23505`, `23503`, `22P02`), not just "throws".
  - Applied to the dev DB with `npm run migration:run`; `migration:revert` drops the table and the enum, and running it again restores them (3 migrations recorded). `openapi.json` is unchanged because `VideosModule` has no controllers yet.
  - Tests ran directly in the container, not through a test sub-agent (nested agent spawns are not allowed in this runtime).

### SI-03.5 — Video Naming and Sizing Rules
- **Status:** completed
- **Tests:** 31 passing (`src/common/validators/max-code-points.validator.spec.ts` 11, `src/videos/video-title.util.spec.ts` 11, `src/videos/video-slug.util.spec.ts` 3, `src/videos/video.constants.spec.ts` 6); full suites 32 suites / 218 tests, e2e 3 suites / 52 tests
- **Observations:**
  - `@MaxCodePoints(n, options?)` uses `registerDecorator` with an inline validator object (`validate` + `defaultMessage`), as in the class-validator 0.14 README (context7 `/typestack/class-validator/v0.14.0`; installed 0.14.4, `ValidationDecoratorOptions` checked in the installed typings). The constraint name is exported as `MAX_CODE_POINTS` (`'maxCodePoints'`); the default message is `<property> must be a string with at most <n> characters`. `undefined`/`null` fail like any non-string, so optional fields need `@IsOptional()` (the plan's `title` rules already have it).
  - Small additions beyond the plan's names: `VIDEO_TITLE_MAX_CODE_POINTS = 100` exported from `video-title.util.ts` (the derivation's cut), so SI-03.6's DTO can use it instead of a bare `100`. The slug byte count is a private constant in `video-slug.util.ts`.
  - `deriveVideoTitle` follows the plan's order literally: drop the last extension, trim, cut to 100. A cut that lands right after a space can leave a trailing space in the derived title; the plan doesn't re-trim, so it was left as written.
  - The `video.constants.ts` constants are plain `export const` numbers (literal types without `as const`, which only matters for objects/arrays). `video-storage-keys.ts` (`originalKey`/`thumbnailKey`) belongs to SI-03.6 in the plan, so it was not created here.
  - Tests added beyond the plan's list: a custom `message` override for `@MaxCodePoints`, an empty string passing, `truncateCodePoints` on its own, a whitespace-only name falling back to the trimmed filename, a 300-emoji filename, and a check that `computePartCount(VIDEO_MAX_SIZE_BYTES) === VIDEO_MAX_PART_COUNT`.
  - Tests ran directly in the container, not through a test sub-agent (nested agent spawns are not allowed in this runtime).

### SI-03.6 — Start Upload and Owner Read (POST /videos, GET /videos/:id)
- **Status:** completed
- **Tests:** 28 passing: `src/videos/videos.service.spec.ts` 11 (unit), `src/videos/videos.service.integration-spec.ts` 5 (real DB + `minio`), `src/channels/channels.service.integration-spec.ts` +2 (`findByUserId`), and `test/videos-start-upload.e2e-spec.ts` 10, which covers all 10 scenarios of `nestjs-project/specs/videos-start-upload.plan.md`. `src/videos/videos.module.spec.ts` was updated (it now needs the storage config and checks the controller and service). Full suites: 34 suites / 236 tests; e2e 4 suites / 62 tests.
- **Observations:**
  - **Plan deviation (accepted in Step 7):** `test/helpers/authenticated-user.ts` (`createAuthenticatedUser(app, dataSource, email, password?)`) is created here, not in SI-03.16. Every controller spec from SI-03.6 on needs register → confirm → login. The helper registers through `POST /auth/register`, sets `is_confirmed = true` through the repository, and logs in through `POST /auth/login`. SI-03.16 reuses it.
  - **`test/jest-e2e.json` gained `"maxWorkers": 1`** (not in the plan). With two DB-touching e2e suites, a plain `npm run test:e2e` ran them in parallel and they wiped each other's tables (15 failures). `nestjs-project/CLAUDE.md` already says the e2e command is "already configured" to run serially; the config now matches that.
  - Slug-collision retry: `repository.insert` (standalone, no transaction), retried only when the pg error is `23505` and its `detail` names `(slug)`. This is the same detection as `ChannelsService`. Every final failure (3 slug collisions, any other error) runs `abortMultipartUpload` and then rethrows.
  - A missing channel throws a plain `Error` before any storage call (phase-02 invariant), as the plan says.
  - `findOwnedById` uses `findOne({ where: { id, channel: { user_id } } })`. TypeORM turns the nested relation filter into an inner join on `channels`.
  - The service returns the entity. The controller maps it with `VideoDto.fromEntity` (exactly the 14 fields of the API contract), so `upload_id`, `thumbnail_key` and `processing_started_at` never reach the HTTP layer.
  - `ParseUUIDPipe` throws `BadRequestException`, and the existing `ValidationExceptionFilter` turns it into `400 VALIDATION_ERROR` with a message array. No new filter was needed.
  - `CreateVideoDto` has only class-validator decorators and JSDoc, following the project's request-DTO rule. In `openapi.json`, `CreateVideoDto` therefore has empty `properties`, like every existing request DTO (`RegisterDto`, `LoginDto`, …). `openapi:export` runs through ts-node, which skips the Swagger CLI plugin. This is pre-existing and recorded as a follow-up. The response DTOs (`VideoUploadSessionDto`, `VideoDto`) use explicit `@ApiProperty` and are fully documented. The `openapi.json` diff only adds lines (`/videos`, `/videos/{id}`, 3 schemas plus `VideoStatus`).
  - The e2e spec keeps minio clean: before each test and in `afterAll` it aborts the multipart session of every row that still has `upload_id`.
  - context7 lookups:
    - NestJS `ParseUUIDPipe` (`@Param('id', ParseUUIDPipe)`).
    - `@nestjs/swagger` `@ApiProperty` / `@ApiResponse` / `@ApiBearerAuth`.
    - class-validator 0.14 decorator signatures.
    - class-transformer `@Transform(({ value }) => …)`.
    - TypeORM nested relation `where` and `insert`/`save`.

    TypeORM's context7 docs track master, while 0.3.28 is installed; the APIs used behave the same in 0.3.28. No other mismatch.
  - Tests ran directly in the container, not through a test sub-agent (nested agent spawns are not allowed in this runtime).

### SI-03.7 — Part Signing and Upload Resume (POST/GET /videos/:id/upload/parts)
- **Status:** completed
- **Tests:** 24 passing: `src/videos/videos.service.spec.ts` +10 (unit, now 21), `src/videos/videos.service.integration-spec.ts` +2 (real DB + `minio`, now 7), and `test/videos-upload-parts.e2e-spec.ts` 12, which covers all 12 scenarios of `nestjs-project/specs/videos-upload-parts.plan.md` (real signed-URL `PUT`s in 1.3 and 2.2). Full suites: 34 suites / 248 tests; e2e 5 suites / 74 tests.
- **Observations:**
  - Both service methods share a private `activeUploadId(video)` guard. Anything other than a `draft`, or a `draft` with a `NULL` `upload_id` (it shouldn't happen, since drafts are inserted with one), throws `VideoUploadNotActiveException` before any storage call. The plan only names the `draft` check; the null-`upload_id` case was folded into it rather than letting a `null` reach the S3 SDK.
  - `signUploadParts` checks every part number against `computePartCount(size_bytes)` before signing, so a mixed `[1, 2]` on a 1-part video signs nothing (spec 1.4). Parts are presigned in parallel (`Promise.all`; signing is offline). `expiresAt` is computed once, right before signing: `Date.now() + UPLOAD_PART_URL_TTL_SECONDS * 1000`, as an ISO string.
  - `listUploadedParts` maps only `UploadSessionNotFoundError` to `VideoUploadNotActiveException`; any other storage error is rethrown unchanged. The row is never modified.
  - `SignUploadPartsDto` uses exactly the Validation Rules decorators and no `@ApiProperty` (request-DTO rule). Its `openapi.json` schema is therefore empty, like every other request DTO (pre-existing follow-up). The response DTOs (`SignedUploadPartsDto`/`SignedUploadPartDto`, `UploadedPartsDto`/`UploadedPartDto`) carry `@ApiProperty`; the nested part classes live in the same files as their parents. `openapi.json` change is additive only (+242 lines).
  - The service returns the response DTO shapes directly. `UploadedPart` from `StorageService` already has the contract's field names, so no mapping layer was added.
  - context7 (`/typestack/class-validator`, develop docs vs installed 0.14.4; `/nestjs/docs.nestjs.com/__branch__11.0.0`): the array decorators, `each: true`, `@ApiProperty({ type: [Dto] })` and `@HttpCode` signatures match the installed versions. No mismatch.
  - Tests ran directly in the container, not through a test sub-agent (nested agent spawns are not allowed in this runtime).

### SI-03.8 — Abort Upload (DELETE /videos/:id/upload)
- **Status:** completed
- **Tests:** 23 passing: `src/videos/video-lifecycle.service.integration-spec.ts` 6 (new, real DB), `src/videos/videos.service.spec.ts` +7 (unit, now 28), `src/videos/videos.service.integration-spec.ts` +2 (real DB + `minio`, now 9), and `test/videos-upload-abort.e2e-spec.ts` 8, which covers all 8 scenarios of `nestjs-project/specs/videos-upload-abort.plan.md`. `videos.module.spec.ts` also asserts that `VideoLifecycleService` resolves (no new test). Full suites: 35 suites / 263 tests; e2e 6 suites / 82 tests.
- **Observations:**
  - `VideoLifecycleService.failDraft(id, reason)` is `repository.update({ id, status: 'draft' }, { status: 'failed', failure_reason, upload_id: null })` and returns `(affected ?? 0) > 0`. TypeORM 0.3.28's Postgres query runner sets `affected` from pg `rowCount`. context7 doesn't say which drivers report it, so this was checked in the installed source. The reason type is `DraftFailureReason` (`Extract<VideoFailureReason, …>`), exported from the same file. The service is provided and exported by `VideosModule`.
  - `abortUpload` reuses SI-03.7's private `activeUploadId` guard for the `draft` pre-check. A `draft` with `NULL` `upload_id` also answers 409, the same choice the user accepted in SI-03.7. The order is `abortMultipartUpload` → `deleteObject` → `failDraft`; `false` → `VideoUploadNotActiveException`. Any other storage error propagates before the status write, so the row stays `draft` and the sweeper can expire it later.
  - Controller: `@Delete(':id/upload')` + `@HttpCode(HttpStatus.NO_CONTENT)`, `ParseUUIDPipe`, `@ApiResponse` 204 with no schema, plus 400/401/404/409 with `ApiErrorEnvelope`. The `openapi.json` change only adds lines (+70).
  - e2e race scenario (1.6): `jest.spyOn(storage, 'deleteObject').mockImplementationOnce(...)` flips the row to `processing`, then calls `storage.deleteObject` again. The once-implementation is already used up, so that call reaches the real method through the spy. `strictBindCallApply` is off, so `bind` returns `any` (lint `no-unsafe-*`), and capturing the method unbound trips `unbound-method`. In 1.4 the `failed` seed also sets `failure_reason = 'PROCESSING_FAILED'`, so "unchanged" is checked against a non-null value. Test cleanup also deletes any `videos/{id}/original` object, besides aborting open sessions.
  - Extra unit tests beyond the plan table: the per-status `it.each` (3), propagation of not-owned, and a storage failure that is rethrown without a status write.
  - context7: `/typeorm/typeorm/0.3.28` (installed 0.3.28) for `Repository.update` / `UpdateResult`; `/nestjs/docs.nestjs.com` for `@Delete` + `@HttpCode(204)`; `/nestjs/swagger/11.4.7` (installed 11.4.2; no 11.4.2 docs, same `ApiResponse` API) for a 204 with no schema. No mismatch affects this code.
  - Tests ran directly in the container, not through a test sub-agent (nested agent spawns are not allowed in this runtime).

### SI-03.9 — Complete Upload and Enqueue Processing (POST /videos/:id/upload/complete)
- **Status:** completed
- **Tests:** 41 passing: `src/videos/videos.service.spec.ts` +16 (unit, now 44), `src/videos/videos.service.integration-spec.ts` +4 (real DB + `minio` + `redis`, now 13), `src/videos/video-processing.queue.integration-spec.ts` 4 (new, real `redis`, `bull-test` prefix), `src/videos/video-lifecycle.service.integration-spec.ts` +6 (now 12), and `test/videos-upload-complete.e2e-spec.ts` 11, which covers all 11 scenarios of `nestjs-project/specs/videos-upload-complete.plan.md`. `videos.module.spec.ts` also asserts that `VideoProcessingQueue` and the `video-processing` queue (with `attempts: 3` defaults) resolve. Full suites: 36 suites / 293 tests; e2e 7 suites / 93 tests.
- **Observations:**
  - `VideoProcessingQueue` (`src/videos/video-processing.queue.ts`): `enqueue` = `add('process', { videoId }, { jobId: videoId })`, with the options taken from the queue's `defaultJobOptions`. `getJobState` returns `'missing'` when `getJob` is `undefined`, otherwise `job.getState()`. `removeJob` = `queue.remove(videoId)`. `VideosModule` holds the only `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS })` and exports `VideoProcessingQueue` + `VideoLifecycleService`. The API now opens a Redis connection at boot. Unit, integration and e2e runs still exit on their own, and so does `openapi:export`.
  - `VideoLifecycleService.markProcessing` is `repository.update({ id, status: 'draft' }, { status: 'processing', upload_id: null, processing_started_at: () => 'now()' })`. It uses the DB clock, like the sweeper's thresholds. Function-style values are documented for the 0.3.28 update builder, and `Repository.update` accepts them through `QueryDeepPartialEntity`.
  - `completeUpload` makes a single `HeadObject` call after `CompleteMultipartUpload`. A storage `NoSuchUpload` is caught and execution falls through to that call (AMB-7): a `null` result → 409 with the row left `draft`. As a consequence, a `null` right after a *successful* complete (an anomaly) also answers 409. On a size mismatch the service throws `UploadSizeMismatchException` even when `failDraft` returns `false` (a concurrent actor moved the row first); the plan names no branch for that race.
  - Part check: the list must be exactly `1..partCount` (`length === partCount` and `parts[i].partNumber === i + 1`). Besides the plan's cases, this also rejects gaps and extra parts. A `draft` with a NULL `upload_id` reuses the `activeUploadId` guard and answers 409, the choice already accepted in SI-03.7/03.8.
  - Controller: `@Post(':id/upload/complete')` + `@HttpCode(200)`, `ParseUUIDPipe`, and `@ApiResponse` for 200 (`VideoProcessingStartedDto`) and 400/401/404/409/422 (`ApiErrorEnvelope`). `CompletedPartDto` lives in `complete-upload.dto.ts`, the same nested-DTO pattern as SI-03.7. `openapi.json` only gained lines (+127). The `CompleteUploadDto` request schema is empty, which is the known pre-existing follow-up.
  - Test setup: `videos.module.spec.ts` and `videos.service.integration-spec.ts` now load `redisConfig` + `QueueModule`, because `VideosModule` registers a queue. The service integration spec also deletes `videos/{id}/original` objects and obliterates the `bull-test` queue in `beforeEach`/`afterAll`. The e2e spec obliterates in `beforeEach`/`afterAll` as the spec requires, and its `describe` label is the feature stem `videos-upload-complete`.
  - After the runs only `bull-test:video-processing:meta` is left in Redis: each `AppModule` boot (auth/swagger/app e2e suites) writes the queue's metadata key, and no job keys remain. `bull:video-processing:meta` comes from `openapi:export` and the boot check (dev prefix).
  - Extra tests beyond the plan table: 4 part-list cases in an `it.each` (fewer, descending, gap, extra), a guarded-update miss that leaves another status, a different storage error rethrown, not-owned propagation, `removeJob`, and "updates only the targeted draft" for `markProcessing`.
  - context7: `/nestjs/bull` (`registerQueue`/`defaultJobOptions`, `@InjectQueue`, `getQueueToken` = `BullQueue_<name>`); `/taskforcesh/bullmq` (duplicate `jobId` ignored, `getJob`, `getState`, `remove` throws for locked jobs; the installed 6.7.1 typings match: `getState(): Promise<JobState | 'unknown'>`); `/typeorm/typeorm/0.3.28` (`Repository.update`, function-style raw values); `/typestack/class-validator` (`ValidateNested({ each: true })`, array sizes; 0.14.4 installed); `/nestjs/swagger` (`getSchemaPath`). No mismatch affects this code.
  - Tests ran directly in the container, not through a test sub-agent (nested agent spawns are not allowed in this runtime).

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
