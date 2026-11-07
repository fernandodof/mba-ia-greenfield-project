---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-start-upload.e2e-spec.ts
---

# Start Upload and Owner Read — Endpoint Test Plan

## Application Overview

`POST /videos` pre-registers a video as a `draft` in the caller's channel and opens an S3 multipart upload for `videos/{id}/original` in the real Silo (MinIO) bucket. It returns `{ id, slug, status, partSize, partCount }` so the client can request presigned part URLs. The title is optional. It is counted in Unicode code points (1–100 after trimming), and when omitted it is derived from `filename` minus its last extension. `GET /videos/:id` lets the owner read the video's lifecycle state in any status. A missing video and a video of another channel both answer `404 VIDEO_NOT_FOUND`. A malformed id is rejected by `ParseUUIDPipe` with `400 VALIDATION_ERROR`. Both routes require a valid access token (global `JwtAuthGuard`), and `VideosController` opts out of the global throttler (`@SkipThrottle()`). Errors use the `{ statusCode, error, message }` envelope.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication()` with the `main.ts` globals reproduced as in `test/auth.e2e-spec.ts` (`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, `DomainExceptionFilter`, `ValidationExceptionFilter`); resolve `DataSource`, `StorageService` and `ThrottlerStorage`. `beforeEach`: `cleanAllTables(dataSource)` (deletes `videos` first) and `throttlerStorage.storage.clear()` (the auth calls below are rate-limited); register user A (owner) and user B (other) through `POST /auth/register` (which also creates their channels), set `is_confirmed = true` through the repository, log in through `POST /auth/login` and keep both access tokens. Real `minio`/`redis` via Compose service names; `src/test/setup-test-env.ts` provides `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` and `QUEUE_PREFIX=bull-test`. `afterAll`: `app.close()`.

#### 1.1. start-upload-creates-draft-with-derived-title

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos as user A with `{ filename: 'clip.mp4', size: 1048576, contentType: 'video/mp4' }`
    - expect: HTTP `201`
    - expect: body is exactly `{ id, slug, status, partSize, partCount }` with `id` a UUID, `slug` matching `^[A-Za-z0-9_-]{11}$`, `status: 'draft'`, `partSize: 67108864`, `partCount: 1`
  2. Read the `videos` row by `id` through the repository
    - expect: `title = 'clip'`, `original_filename = 'clip.mp4'`, `content_type = 'video/mp4'`, `size_bytes = 1048576`, `status = 'draft'`, `upload_id` not null
    - expect: the row's `channel_id` is user A's channel

#### 1.2. start-upload-keeps-explicit-title-and-computes-part-count

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos as user A with `{ title: '  My first video  ', filename: 'raw.mov', size: 67108865, contentType: 'video/quicktime' }`
    - expect: HTTP `201` with `partCount: 2` (64 MiB + 1 byte)
    - expect: the stored `title` is `My first video` (trimmed)
  2. POST /videos as user A with a `title` of 100 emoji (100 code points, 200 UTF-16 units)
    - expect: HTTP `201`; the stored `title` equals the 100-emoji string unchanged

#### 1.3. start-upload-opens-multipart-session-in-storage

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos as user A with a valid body
    - expect: HTTP `201`
  2. Read the row's `upload_id` and call `StorageService.listParts('videos/{id}/original', upload_id)` against the real `minio`
    - expect: it resolves to `[]` (the multipart upload exists and has no parts yet) instead of throwing `UploadSessionNotFoundError`

#### 1.4. start-upload-rejects-invalid-body

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos as user A with a `title` of 101 code points
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"` and a `message` array
  2. POST /videos as user A with `size: 10737418241`
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"`
  3. POST /videos as user A with `contentType: 'image/png'`
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"`
  4. POST /videos as user A with a whitespace-only `title` (`'   '`) and, separately, with an unknown extra field (`uploadId: 'x'`)
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"` in both cases
  5. Count the `videos` rows
    - expect: `0` — no draft is created for a rejected body

#### 1.5. start-upload-requires-access-token

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos with a valid body and no `Authorization` header
    - expect: HTTP `401`
  2. POST /videos with a valid body and `Authorization: Bearer not-a-jwt`
    - expect: HTTP `401`
    - expect: no `videos` row exists afterwards

#### 1.6. start-upload-not-rate-limited

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos as user A with a valid body 11 times in a row (more than the global throttler's 10 requests/min)
    - expect: every response is `201`; none is `429` (`@SkipThrottle()` on `VideosController`)

### 2. GET /videos/:id

**Setup:** same as group 1; user A starts an upload through `POST /videos` (`{ filename: 'clip.mp4', size: 1048576, contentType: 'video/mp4' }`) to obtain a draft `id`.

#### 2.1. owner-reads-fresh-draft

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. GET /videos/:id as user A
    - expect: HTTP `200`
    - expect: body has exactly the documented fields `id`, `slug`, `title`, `status`, `failureReason`, `originalFilename`, `contentType`, `sizeBytes`, `durationMs`, `width`, `height`, `videoCodec`, `createdAt`, `updatedAt`
    - expect: `status: 'draft'`, `title: 'clip'`, `originalFilename: 'clip.mp4'`, `contentType: 'video/mp4'`, `sizeBytes: 1048576` (a JSON number), `failureReason: null`, `durationMs: null`, `width: null`, `height: null`, `videoCodec: null`; `createdAt`/`updatedAt` are ISO 8601 strings
    - expect: the body has no `uploadId`, `upload_id`, `thumbnailKey`, `thumbnail_key`, `processingStartedAt` or `processing_started_at` property

#### 2.2. owner-reads-video-in-any-status

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. Set the row to `status = 'failed'`, `failure_reason = 'UPLOAD_ABORTED'`, `upload_id = NULL` through the repository
  2. GET /videos/:id as user A
    - expect: HTTP `200` with `status: 'failed'` and `failureReason: 'UPLOAD_ABORTED'`
  3. Set the row to `status = 'ready'` with `duration_ms = 5000`, `width = 640`, `height = 360`, `video_codec = 'h264'`, `thumbnail_key = 'videos/{id}/thumbnail.jpg'` through the repository
  4. GET /videos/:id as user A
    - expect: HTTP `200` with `status: 'ready'`, `durationMs: 5000`, `width: 640`, `height: 360`, `videoCodec: 'h264'`
    - expect: no thumbnail key or thumbnail URL in the body

#### 2.3. non-owner-and-unknown-id-get-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. GET /videos/:id as user B (user A's video)
    - expect: HTTP `404` with `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`
  2. GET /videos/{random UUID} as user A
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"` (same response as step 1 — ownership is not revealed)

#### 2.4. malformed-id-and-missing-token-rejected

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. GET /videos/not-a-uuid as user A
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"` (`ParseUUIDPipe`)
  2. GET /videos/:id with no `Authorization` header
    - expect: HTTP `401`
