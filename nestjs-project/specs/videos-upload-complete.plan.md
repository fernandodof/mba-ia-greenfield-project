---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-upload-complete.e2e-spec.ts
---

# Complete Upload and Enqueue Processing — Endpoint Test Plan

## Application Overview

`POST /videos/:id/upload/complete` finishes the S3 multipart upload of the owner's `draft` video. It checks the stored size with `HeadObject`, moves the row `draft → processing` with a guarded update (`upload_id = NULL`, `processing_started_at = now()`), and only after that commit enqueues a `process` job on the `video-processing` queue with `jobId = videoId`, payload `{ videoId }` and the shared defaults (`attempts: 3`). The call is idempotent. A repeat on a `processing` video returns the same `200` and re-adds the deterministic job, which BullMQ ignores. When storage already completed the upload but the row is still `draft` (`NoSuchUpload`), `HeadObject` decides: if the object exists, the call continues; if it is missing, it answers `409`. Error contracts:
- `400 UPLOAD_PARTS_INVALID`: parts not exactly `partCount` in ascending order, or storage `InvalidPart`/`InvalidPartOrder`. The video stays `draft`.
- `422 UPLOAD_SIZE_MISMATCH`: the object is deleted and the row becomes `failed`/`UPLOAD_SIZE_MISMATCH`.
- `409 VIDEO_UPLOAD_NOT_ACTIVE`: `ready`/`failed` videos, or a gone upload with no object.
- `404 VIDEO_NOT_FOUND`: missing or foreign video.
- `400 VALIDATION_ERROR`: DTO violation or a malformed id.

The e2e app is the API only (no worker), so enqueued jobs stay `waiting` and can be inspected. The queue uses `QUEUE_PREFIX=bull-test`, so the Compose `video-worker` never consumes them.

## Test Scenarios

### 1. POST /videos/:id/upload/complete

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication()` with the `main.ts` globals reproduced as in `test/auth.e2e-spec.ts` (`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, `DomainExceptionFilter`, `ValidationExceptionFilter`); resolve `DataSource`, `StorageService`, `ThrottlerStorage` and the `video-processing` `Queue` (`app.get(getQueueToken(VIDEO_PROCESSING_QUEUE))`). `beforeEach`: `cleanAllTables(dataSource)`, `throttlerStorage.storage.clear()` and `queue.obliterate({ force: true })` (only `bull-test:video-processing:*` keys); register, confirm (`is_confirmed = true` through the repository) and log in user A (owner) and user B (other). Helper `uploadDraft(token, bytes, declaredSize?)`: `POST /videos` (`filename: 'clip.mp4'`, `contentType: 'video/mp4'`, `size: declaredSize ?? bytes.length`) → `POST /videos/:id/upload/parts { partNumbers: [1] }` → `fetch` PUT of `bytes` → returns `{ id, slug, etag }`; default `bytes` = 2048 random bytes (`partCount: 1`). `afterAll`: `queue.obliterate({ force: true })`, then `app.close()`.

#### 1.1. complete-moves-draft-to-processing

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `uploadDraft` as user A
  2. POST /videos/:id/upload/complete as user A with `{ parts: [{ partNumber: 1, etag }] }`
    - expect: HTTP `200` (not `201`) with exactly `{ id, slug, status: 'processing' }` matching the draft's `id` and `slug`
  3. Read the row through the repository
    - expect: `status = 'processing'`, `upload_id IS NULL`, `processing_started_at` not null
  4. Call `StorageService.headObject('videos/{id}/original')`
    - expect: `{ size: 2048 }`

#### 1.2. complete-enqueues-deterministic-processing-job

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `uploadDraft` as user A and POST /videos/:id/upload/complete with its part
    - expect: HTTP `200`
  2. `queue.getJob(id)`
    - expect: a job exists with `id = videoId`, `name = 'process'`, `data` deep-equal to `{ videoId: id }`
    - expect: `job.opts.attempts = 3` and `job.opts.backoff` = `{ type: 'exponential', delay: 10000 }`
    - expect: `await job.getState()` is `'waiting'`

#### 1.3. complete-is-idempotent

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `uploadDraft` as user A and POST /videos/:id/upload/complete with its part; keep the body
  2. POST /videos/:id/upload/complete again with the same body
    - expect: HTTP `200` with a body deep-equal to the first response
  3. List the queue's jobs (`queue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed'])`)
    - expect: exactly one job, with `id = videoId`
    - expect: the row is still `processing` and `processing_started_at` is unchanged from step 1

#### 1.4. complete-rejects-wrong-etag

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `uploadDraft` as user A
  2. POST /videos/:id/upload/complete with `{ parts: [{ partNumber: 1, etag: '"00000000000000000000000000000000"' }] }`
    - expect: HTTP `400` with `{ statusCode: 400, error: "UPLOAD_PARTS_INVALID", message: "Upload parts are invalid" }`
    - expect: the row is still `draft` with its `upload_id`; `queue.getJob(id)` is `undefined`
  3. POST /videos/:id/upload/complete again with the real `etag`
    - expect: HTTP `200` with `status: 'processing'` (the client can resume after a parts error)

#### 1.5. complete-rejects-incomplete-or-unordered-parts

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. User A starts an upload with `POST /videos` and `size: 67108865` (`partCount: 2`) — no bytes need to be uploaded, the check happens before storage
  2. POST /videos/:id/upload/complete with only `{ parts: [{ partNumber: 1, etag: '"a"' }] }`
    - expect: HTTP `400` with `error: "UPLOAD_PARTS_INVALID"`
  3. POST with `{ parts: [{ partNumber: 2, etag: '"b"' }, { partNumber: 1, etag: '"a"' }] }` (descending)
    - expect: HTTP `400` with `error: "UPLOAD_PARTS_INVALID"`
    - expect: the row is still `draft` with its `upload_id`, and no job was enqueued

#### 1.6. complete-rejects-invalid-body-and-id

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `uploadDraft` as user A; POST /videos/:id/upload/complete with `{ parts: [] }`
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"` (DTO, distinct from `UPLOAD_PARTS_INVALID`)
  2. POST with `{ parts: [{ partNumber: 1, etag: '' }] }` and, separately, with `{ parts: [{ partNumber: 0, etag: '"a"' }] }`
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"` in both cases
  3. POST /videos/not-a-uuid/upload/complete with a valid body
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"` (`ParseUUIDPipe`)
    - expect: the row is still `draft`

#### 1.7. complete-detects-size-mismatch

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `uploadDraft` as user A with 1024 random bytes but a declared `size` of 2048
  2. POST /videos/:id/upload/complete with its part
    - expect: HTTP `422` with `{ statusCode: 422, error: "UPLOAD_SIZE_MISMATCH", message: "Uploaded size does not match the declared size" }`
  3. Read the row through the repository and call `StorageService.headObject('videos/{id}/original')`
    - expect: `status = 'failed'`, `failure_reason = 'UPLOAD_SIZE_MISMATCH'`, `upload_id IS NULL`
    - expect: `headObject` returns `null` (the object was deleted)
    - expect: `queue.getJob(id)` is `undefined`

#### 1.8. complete-recovers-when-storage-already-completed

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `uploadDraft` as user A, then complete the multipart upload directly in storage with `StorageService.completeMultipartUpload('videos/{id}/original', upload_id, [{ partNumber: 1, etag }])`; the row stays `draft` (simulated crash between storage completion and DB commit)
  2. POST /videos/:id/upload/complete as user A with `{ parts: [{ partNumber: 1, etag }] }`
    - expect: HTTP `200` with `status: 'processing'`
    - expect: the row is `processing` with `upload_id IS NULL`, and `queue.getJob(id)` exists

#### 1.9. complete-409-when-upload-gone-and-no-object

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `uploadDraft` as user A, then abort the multipart upload directly in storage with `StorageService.abortMultipartUpload('videos/{id}/original', upload_id)`
  2. POST /videos/:id/upload/complete with `{ parts: [{ partNumber: 1, etag }] }`
    - expect: HTTP `409` with `{ statusCode: 409, error: "VIDEO_UPLOAD_NOT_ACTIVE", message: "Video has no active upload session" }`
    - expect: the row is still `status = 'draft'` (the sweeper owns expiry); no job was enqueued

#### 1.10. complete-rejects-ready-or-failed-video

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `uploadDraft` as user A; for each status in `ready` and `failed`, set the row's `status` through the repository (with `failure_reason = 'UPLOAD_ABORTED'` for `failed`)
  2. POST /videos/:id/upload/complete with its part
    - expect: HTTP `409` with `error: "VIDEO_UPLOAD_NOT_ACTIVE"` for each status
    - expect: the row's `status` is unchanged and no job was enqueued

#### 1.11. complete-hides-other-users-video

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `uploadDraft` as user A; POST /videos/:id/upload/complete as user B with A's part
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"`; the row is still `draft` and no job was enqueued
  2. POST /videos/{random UUID}/upload/complete as user A with a valid body
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"`
  3. POST /videos/:id/upload/complete with no `Authorization` header
    - expect: HTTP `401`
