---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload-abort.e2e-spec.ts
---

# Abort Upload — Endpoint Test Plan

## Application Overview

`DELETE /videos/:id/upload` lets the owner abort the in-progress upload of a `draft` video. It runs `AbortMultipartUpload` (a missing upload is tolerated), then `DeleteObject` on `videos/{id}/original` (idempotent, covering the storage-complete crash window), then a guarded `UPDATE … SET status = 'failed', failure_reason = 'UPLOAD_ABORTED', upload_id = NULL WHERE id = :id AND status = 'draft'` through `VideoLifecycleService.failDraft`. The row is kept as an auditable `failed` video. The route answers `204`. A non-`draft` video answers `409 VIDEO_UPLOAD_NOT_ACTIVE` without touching storage. When the guarded update matches no row because a concurrent `complete` moved the video first, the route also answers `409 VIDEO_UPLOAD_NOT_ACTIVE`. Owner scoping answers `404 VIDEO_NOT_FOUND` for missing or foreign videos, and a malformed id answers `400 VALIDATION_ERROR`. Tests run against the real `minio` and Postgres.

## Test Scenarios

### 1. DELETE /videos/:id/upload

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication()` with the `main.ts` globals reproduced as in `test/auth.e2e-spec.ts` (`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, `DomainExceptionFilter`, `ValidationExceptionFilter`); resolve `DataSource`, `StorageService` and `ThrottlerStorage`. `beforeEach`: `cleanAllTables(dataSource)` and `throttlerStorage.storage.clear()`; register, confirm (`is_confirmed = true` through the repository) and log in user A (owner) and user B (other); user A starts an upload through `POST /videos` with `{ filename: 'clip.mp4', size: 1048576, contentType: 'video/mp4' }` and keeps `id` and the row's `upload_id`. `afterEach`: `jest.restoreAllMocks()`. `afterAll`: `app.close()`.

#### 1.1. abort-draft-marks-failed-upload-aborted

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. DELETE /videos/:id/upload as user A
    - expect: HTTP `204` with an empty body
  2. Read the row through the repository
    - expect: `status = 'failed'`, `failure_reason = 'UPLOAD_ABORTED'`, `upload_id IS NULL`
  3. GET /videos/:id as user A
    - expect: HTTP `200` with `status: 'failed'` and `failureReason: 'UPLOAD_ABORTED'`

#### 1.2. abort-releases-multipart-upload-and-original-object

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. Sign part 1 through `POST /videos/:id/upload/parts` and `PUT` 1024 random bytes to its URL
  2. Simulate the crash window by putting an object at `videos/{id}/original` with `StorageService.putObject`
  3. DELETE /videos/:id/upload as user A
    - expect: HTTP `204`
  4. Call `StorageService.listParts('videos/{id}/original', <original upload_id>)`
    - expect: it rejects with `UploadSessionNotFoundError` (the multipart upload no longer exists)
  5. Call `StorageService.headObject('videos/{id}/original')`
    - expect: `null` (the original object was deleted)

#### 1.3. abort-tolerates-already-gone-storage-upload

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. Abort the multipart upload directly in storage with `StorageService.abortMultipartUpload('videos/{id}/original', upload_id)`; the row stays `draft`
  2. DELETE /videos/:id/upload as user A
    - expect: HTTP `204`
    - expect: the row becomes `failed` / `UPLOAD_ABORTED` with `upload_id IS NULL`

#### 1.4. abort-rejects-non-draft-video-without-storage-calls

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. Spy on `StorageService.abortMultipartUpload` and `StorageService.deleteObject`
  2. For each status in `processing`, `ready` and `failed`, set the row's `status` through the repository and DELETE /videos/:id/upload as user A
    - expect: HTTP `409` with `{ statusCode: 409, error: "VIDEO_UPLOAD_NOT_ACTIVE", message: "Video has no active upload session" }` for each status
    - expect: the row's `status` and `failure_reason` are unchanged
    - expect: neither storage spy was called

#### 1.5. second-abort-returns-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. DELETE /videos/:id/upload as user A
    - expect: HTTP `204`
  2. DELETE /videos/:id/upload as user A again
    - expect: HTTP `409` with `error: "VIDEO_UPLOAD_NOT_ACTIVE"`; the row keeps `failure_reason = 'UPLOAD_ABORTED'`

#### 1.6. abort-loses-race-to-concurrent-complete

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. `jest.spyOn(storageService, 'deleteObject')` with a one-time implementation that first sets the row to `status = 'processing'`, `upload_id = NULL`, `processing_started_at = now()` through the repository (a concurrent `complete` winning after the `draft` pre-check), then calls the original method
  2. DELETE /videos/:id/upload as user A
    - expect: HTTP `409` with `error: "VIDEO_UPLOAD_NOT_ACTIVE"` (the guarded update matched no row)
    - expect: the row is still `status = 'processing'` with `failure_reason IS NULL`; the abort did not overwrite it

#### 1.7. abort-hides-other-users-video

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. DELETE /videos/:id/upload as user B (user A's video)
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"`
    - expect: the row is still `draft` with its `upload_id`, and `StorageService.listParts` on it still resolves (nothing was aborted)
  2. DELETE /videos/{random UUID}/upload as user A
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"`

#### 1.8. abort-rejects-malformed-id-and-missing-token

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. DELETE /videos/not-a-uuid/upload as user A
    - expect: HTTP `400` with `error: "VALIDATION_ERROR"` (`ParseUUIDPipe`)
  2. DELETE /videos/:id/upload with no `Authorization` header
    - expect: HTTP `401`; the row is still `draft`
