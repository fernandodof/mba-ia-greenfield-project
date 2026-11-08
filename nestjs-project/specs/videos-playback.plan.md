---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-playback.e2e-spec.ts
---

# Streaming and Download by Unique Slug — Endpoint Test Plan

## Application Overview

`GET /videos/:slug/stream` and `GET /videos/:slug/download` are `@Public()` routes keyed by the video's unique 11-character slug. For a `ready` video they answer `302 Found` with `Cache-Control: no-store`. The `Location` is a presigned `GetObject` URL for `videos/{id}/original`, signed with the public S3 client with a 1 h TTL (`expiresIn: 3600`). Storage then serves `Range` requests with `206 Partial Content`, so the API stays out of the data path. The stream URL has no response overrides: the object carries its declared `Content-Type`. The download URL adds `ResponseContentDisposition = attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`. The filename is the sanitized title plus the original extension, lower-cased and kept only if it matches `^[a-z0-9]{1,10}$`. An unknown slug and a non-`ready` video (`draft`, `processing`, `failed`) both answer `404 VIDEO_NOT_FOUND`, so the state is not revealed. In the test env `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` (`http://minio:9000`), so the test process can follow `Location` from inside the container.

## Test Scenarios

### 1. GET /videos/:slug/stream

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication()` with the `main.ts` globals reproduced as in `test/auth.e2e-spec.ts` (`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, `DomainExceptionFilter`, `ValidationExceptionFilter`); resolve `DataSource`, `StorageService` and `ThrottlerStorage`. `beforeEach`: `cleanAllTables(dataSource)` and `throttlerStorage.storage.clear()`; register user A through `POST /auth/register` (creates the channel), confirm (`is_confirmed = true` through the repository) and log in. Helper `seedVideo({ status, title, originalFilename, contentType })`: insert a `videos` row for user A's channel through the repository (`id = randomUUID()`, `slug = generateVideoSlug()`, `size_bytes` = object size), and for `ready` rows also `StorageService.putObject('videos/{id}/original', <2048 random bytes>, contentType)`. No upload or worker flow is needed (this SI depends only on SI-03.6). Requests to the API use supertest **without following redirects**; the `Location` is fetched with `fetch(location, { redirect: 'manual' })` from the test process. `afterAll`: `app.close()`.

#### 1.1. stream-redirects-anonymous-caller-to-presigned-url

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. Seed a `ready` video (`contentType: 'video/mp4'`)
  2. GET /videos/:slug/stream with no `Authorization` header
    - expect: HTTP `302`
    - expect: `Cache-Control` header equals `no-store`
    - expect: `new URL(Location).host` equals `new URL(process.env.S3_PUBLIC_ENDPOINT).host`, and the path targets `videos/{id}/original`
    - expect: the `Location` query carries `X-Amz-Expires=3600` and no `response-content-disposition` / `response-content-type` parameter
  3. GET /videos/:slug/stream with user A's access token
    - expect: HTTP `302` as well (public route also works for authenticated callers)

#### 1.2. stream-location-serves-range-with-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. Seed a `ready` video with `contentType: 'video/mp4'` and keep the 2048 seeded bytes
  2. GET /videos/:slug/stream and read `Location`
  3. `fetch(Location, { headers: { Range: 'bytes=0-1023' } })`
    - expect: status `206`
    - expect: the body has exactly 1024 bytes, equal to the first 1024 seeded bytes
    - expect: `Content-Type` is `video/mp4` (the declared type stored on the object)
    - expect: `Content-Range` is `bytes 0-1023/2048`

#### 1.3. stream-404-for-unknown-or-non-ready-video

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. GET /videos/AAAAAAAAAAA/stream (well-formed, unknown slug)
    - expect: HTTP `404` with `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }` and no `Location` header
  2. Seed one video each in `draft`, `processing` and `failed` (`failure_reason = 'INVALID_MEDIA'`); GET /videos/:slug/stream for each, without a token
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"` for each — the same body as the unknown slug
  3. GET /videos/:slug/stream for the `draft` video with user A's (the owner's) token
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"` (ownership does not unlock non-`ready` playback)

### 2. GET /videos/:slug/download

**Setup:** same as group 1.

#### 2.1. download-redirects-with-content-disposition

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. Seed a `ready` video with `title: 'Férias: dia 1/2'`, `originalFilename: 'clip.MP4'`, `contentType: 'video/mp4'`
  2. GET /videos/:slug/download with no `Authorization` header
    - expect: HTTP `302` with `Cache-Control: no-store`
    - expect: `Location` is on the `S3_PUBLIC_ENDPOINT` host, targets `videos/{id}/original` and carries `X-Amz-Expires=3600`
  3. `fetch(Location)`
    - expect: status `200`
    - expect: `Content-Disposition` equals `attachment; filename="F_rias dia 12.mp4"; filename*=UTF-8''F%C3%A9rias%20dia%2012.mp4`

#### 2.2. download-omits-invalid-extension

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. Seed a `ready` video with `title: 'My clip'` and `originalFilename: 'noext'`
  2. GET /videos/:slug/download, then `fetch(Location)`
    - expect: `Content-Disposition` equals `attachment; filename="My clip"; filename*=UTF-8''My%20clip`
  3. Seed a `ready` video with `title: 'My clip'` and `originalFilename: 'a.verylongext1'` (11-character extension)
  4. GET /videos/:slug/download, then `fetch(Location)`
    - expect: `Content-Disposition` equals `attachment; filename="My clip"; filename*=UTF-8''My%20clip` (no extension)

#### 2.3. download-404-for-unknown-or-non-ready-video

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-07T09:32:11Z

**Steps:**
  1. GET /videos/AAAAAAAAAAA/download (unknown slug)
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"` and no `Location` header
  2. Seed one video each in `draft`, `processing` and `failed`; GET /videos/:slug/download for each
    - expect: HTTP `404` with `error: "VIDEO_NOT_FOUND"` for each
