---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-parts.e2e-spec.ts
---

# Part Signing and Upload Resume — Endpoint Test Plan

## Application Overview

`POST /videos/:id/upload/parts` gives the owner of a `draft` video short-lived (3600 s) presigned `UploadPart` URLs. The URLs are signed with the public S3 client, so the file bytes go straight to storage and never through the API. `GET /videos/:id/upload/parts` lists the parts already stored in the multipart upload, so an interrupted upload can resume. Both routes are owner-scoped: a missing video or one of another channel answers `404 VIDEO_NOT_FOUND`. A non-`draft` video answers `409 VIDEO_UPLOAD_NOT_ACTIVE`, and so does a `draft` whose storage upload no longer exists (on `GET`). A part number above the video's `partCount` answers `400 UPLOAD_PARTS_INVALID`, while DTO violations answer `400 VALIDATION_ERROR`. Tests run in the `nestjs-api` container against the real `minio`. The test env sets `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` (`http://minio:9000`), so the signed URLs can be `PUT` from the test process.

## Test Scenarios

### 1. POST /videos/:id/upload/parts

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication()` with the `main.ts` globals reproduced as in `test/auth.e2e-spec.ts` (`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, `DomainExceptionFilter`, `ValidationExceptionFilter`); resolve `DataSource`, `StorageService` and `ThrottlerStorage`. `beforeEach`: `cleanAllTables(dataSource)` and `throttlerStorage.storage.clear()`; register, confirm (`is_confirmed = true` through the repository) and log in user A (owner) and user B (other); user A starts an upload through `POST /videos` with `{ filename: 'clip.mp4', size: 1048576, contentType: 'video/mp4' }` (`partCount: 1`) and keeps `id`. `src/test/setup-test-env.ts` provides `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` and `QUEUE_PREFIX=bull-test`. `afterAll`: `app.close()`.

#### 1.1. sign-part-returns-public-url-with-one-hour-expiry

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos/:id/upload/parts as user A with `{ partNumbers: [1] }`
    - expect: HTTP `200` (not `201`)
    - expect: body `{ parts: [{ partNumber: 1, url }], expiresAt }` with exactly one entry
    - expect: `new URL(url).host` equals `new URL(process.env.S3_PUBLIC_ENDPOINT).host`, and the URL path targets `videos/{id}/original` with `partNumber=1` and the stored `uploadId` in the query
    - expect: the URL query carries `X-Amz-Expires=3600` and no `x-amz-sdk-checksum-algorithm` / `x-amz-checksum-*` parameter
    - expect: `expiresAt` is an ISO 8601 string within ±60 s of now + 3600 s

#### 1.2. sign-multiple-parts-for-multi-part-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. User A starts a second upload with `size: 67108865` (`partCount: 2`)
  2. POST /videos/:id/upload/parts for that video with `{ partNumbers: [1, 2] }`
    - expect: HTTP `200` with two entries, `partNumber` `1` and `2`, each with a distinct `url`

#### 1.3. signed-url-accepts-plain-put

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos/:id/upload/parts as user A with `{ partNumbers: [1] }`
  2. `fetch(url, { method: 'PUT', body: <1024 random bytes> })` from the test process, with no checksum or `Content-Type` headers
    - expect: response status `200`
    - expect: an `ETag` response header is present and non-empty

#### 1.4. sign-rejects-part-above-part-count

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos/:id/upload/parts as user A with `{ partNumbers: [2] }` (`partCount + 1` for a 1 MiB video)
    - expect: HTTP `400` with `{ statusCode: 400, error: "UPLOAD_PARTS_INVALID", message: "Upload parts are invalid" }`
  2. POST with `{ partNumbers: [1, 2] }`
    - expect: HTTP `400` with `error: "UPLOAD_PARTS_INVALID"` (no partial signing)

#### 1.5. sign-rejects-invalid-part-numbers-body

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos/:id/upload/parts as user A with `{ partNumbers: [] }`
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"`
  2. POST with `{ partNumbers: [1, 1] }`
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"`
  3. POST with `{ partNumbers: [0] }` and, separately, with no body
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"` in both cases
  4. POST /videos/not-a-uuid/upload/parts with `{ partNumbers: [1] }`
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"` (`ParseUUIDPipe`)

#### 1.6. sign-rejects-non-draft-video

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. For each status in `processing`, `ready` and `failed`, set the row's `status` through the repository
  2. POST /videos/:id/upload/parts as user A with `{ partNumbers: [1] }`
    - expect: HTTP `409` with `{ statusCode: 409, error: "VIDEO_UPLOAD_NOT_ACTIVE", message: "Video has no active upload session" }` for each status

#### 1.7. sign-hides-other-users-video

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos/:id/upload/parts as user B with `{ partNumbers: [1] }` (user A's video)
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"`
  2. POST /videos/{random UUID}/upload/parts as user A
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"`
  3. POST /videos/:id/upload/parts with no `Authorization` header
    - expect: HTTP `401`

### 2. GET /videos/:id/upload/parts

**Setup:** same as group 1.

#### 2.1. list-parts-empty-before-any-upload

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. GET /videos/:id/upload/parts as user A right after `POST /videos`
    - expect: HTTP `200` with `{ parts: [] }`

#### 2.2. list-parts-returns-uploaded-part-for-resume

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. POST /videos/:id/upload/parts as user A with `{ partNumbers: [1] }`, then `PUT` 1024 random bytes to the returned `url` and keep the `ETag`
  2. GET /videos/:id/upload/parts as user A
    - expect: HTTP `200` with `parts: [{ partNumber: 1, etag, size: 1024 }]`
    - expect: `etag` equals the `ETag` returned by the `PUT`

#### 2.3. list-parts-rejects-non-draft-video

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. Set the row to `status = 'processing'` through the repository
  2. GET /videos/:id/upload/parts as user A
    - expect: HTTP `409` with `error: "VIDEO_UPLOAD_NOT_ACTIVE"`

#### 2.4. list-parts-409-when-storage-upload-gone

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. Abort the multipart upload directly in storage with `StorageService.abortMultipartUpload('videos/{id}/original', upload_id)`; the row stays `draft`
  2. GET /videos/:id/upload/parts as user A
    - expect: HTTP `409` with `error: "VIDEO_UPLOAD_NOT_ACTIVE"` (`NoSuchUpload` mapped)
    - expect: the row is still `status = 'draft'` (listing never changes state)

#### 2.5. list-parts-hides-other-users-video

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. GET /videos/:id/upload/parts as user B (user A's video)
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/not-a-uuid/upload/parts as user A
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"`
  3. GET /videos/:id/upload/parts with no `Authorization` header
    - expect: HTTP `401`
