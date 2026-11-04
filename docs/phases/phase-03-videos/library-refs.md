---
libs:
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-04T15:20:00-03:00"
  bullmq:
    version: "^6.6.1"
    context7_id: "/taskforcesh/bullmq/v6.5.3"
    fetched_at: "2026-11-04T15:20:00-03:00"
  ioredis:
    version: "^5.11.1"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-11-04T15:20:00-03:00"
  "redis (Docker image)":
    version: "8.10.3-alpine"
    context7_id: "—"
    fetched_at: "2026-11-04T15:20:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-04T15:20:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-04T15:20:00-03:00"
  "pgsty/silo + pgsty/mc (Docker images)":
    version: "RELEASE.2026-10-26T00-00-00Z"
    context7_id: "/minio/minio"
    fetched_at: "2026-11-04T15:20:00-03:00"
  "ffmpeg / ffprobe (Debian apt)":
    version: "5.1.x (7:5.1.9-0+deb12u1, bookworm)"
    context7_id: "/websites/ffmpeg_ffmpeg-all"
    fetched_at: "2026-11-04T15:20:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T15:21:47-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries, images and binaries pinned for this slice, from the `**Libraries:**` lines of `docs/decisions/technical-decisions-phase-03-videos.md`. Pulled via Context7 on 2026-11-04 and cross-checked against the npm registry, Docker Hub and the bookworm apt index. Re-fetch when the underlying TD changes.

## Version pinning summary

| Lib / artifact | Pin | Latest seen 2026-11-04 | Context7 id (doc version) | Discrepancy / note |
|---|---|---|---|---|
| `@nestjs/bullmq` | `^12.0.0` | 12.0.0 | `/nestjs/bull` (unversioned `master` autodocs) | Docs aren't versioned. Peer deps (npm): `bullmq ^3‖^4‖^5‖^6`, `@nestjs/common|core ^10‖^11‖^12`, so Nest 11 is OK. Does not pass BullMQ 6's backend factory: the Redis backend only. |
| `bullmq` | `^6.6.1` | 6.6.1 (released 2026-11-04; 6.x ships almost daily) | `/taskforcesh/bullmq/v6.5.3` | Context7 lags npm by one minor (6.5.3 vs 6.6.1). Nothing used here changed between them. `ioredis` is an **optional peer** in v6 and must be installed explicitly. |
| `ioredis` | `^5.11.1` | 6.0.0 (2026-07-31) | `/redis/ioredis` (versions v5.11.1, v6.0.0) | Deliberately **not** 6.x: BullMQ 6.6.1's own devDependency is `ioredis@5.11.1`, and its peer range is `>=5.0.0`. Revisit when BullMQ moves its tests to 6. |
| `redis` image | `redis:8.10.3-alpine` | 8.10.3 | — (server; behaviour taken from BullMQ "Going to production") | Must run with `--maxmemory-policy noeviction`. |
| `@aws-sdk/client-s3` | `^3.1161.0` | 3.1161.0 | `/aws/aws-sdk-js-v3` (latest indexed v3.1153.0) | Context7 index lags a few patch-level releases; the APIs used here are stable. Default checksum behaviour needs an override (see below). |
| `@aws-sdk/s3-request-presigner` | `^3.1161.0` | 3.1161.0 | `/aws/aws-sdk-js-v3` | Keep in lock-step with `client-s3` (same monorepo version). |
| `pgsty/silo` / `pgsty/mc` | `RELEASE.2026-10-26T00-00-00Z` | same (also `latest`, `-distroless`) | `/minio/minio` (upstream MinIO docs) | Upstream docs still cite `quay.io/minio/minio` / `minio/minio`, which are gone. The Silo binary is `silo`, not `minio`. TD-07 originally noted 2026-10-18; bumped to the newest release. |
| `ffmpeg` / `ffprobe` | apt `ffmpeg` 5.1.x on `node:25.6.0-slim` (bookworm), `7:5.1.9-0+deb12u1` | FFmpeg 8.x upstream | `/websites/ffmpeg_ffmpeg-all` (current upstream = 8.x) | **Version mismatch:** the docs describe 8.x while the binary is 5.1. Every option used below was verified on the 5.1.9 binary (`ffmpeg -h filter=scale`). Don't adopt newer HTTP options (`libcurl:` protocol, `initial_request_size`); if HTTP seeking is slow, fall back to TD-09 Option B (temp download). |

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7, High reputation). Maps to `phase-03-videos/TD-01` (A), `TD-04` (sweeper scheduler), `TD-08` (worker entrypoint) and `TD-12`/`TD-13` revisions.

### Root connection (both API and worker)

```ts
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [redisConfig.KEY],
  useFactory: (cfg: ConfigType<typeof redisConfig>) => ({
    connection: { host: cfg.host, port: cfg.port }, // host = Compose service name ("redis"), never localhost
  }),
});
```

`forRootAsync` registers a **global** shared config. `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions })` registers the queue in the module that produces jobs. A `Queue` is injected with `@InjectQueue('video-processing')` (token `BullQueue_<name>`).

### Worker side (`src/worker.ts`, TD-08)

```ts
@Processor('video-processing', { concurrency: 1 }) // TD-08: start at 1, env-configurable
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> { /* ffprobe → thumbnail → ready */ }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ videoId: string }> | undefined, err: Error) { /* TD-12 revision: terminal write */ }
}
```

- `@Processor(name, workerOptions)` takes the raw BullMQ `WorkerOptions` (`concurrency`, `limiter`, …) as its second argument.
- `@OnWorkerEvent(eventName)` takes any `WorkerListener` event (`'failed'`, `'completed'`, `'stalled'`, `'error'`, …). The class must carry `@Processor`.
- Only register the `@Processor` provider in the **worker** app context. The API module imports `registerQueue` without the processor, so the API process never consumes jobs.
- `registerQueue` attaches `onApplicationShutdown` and closes workers and queue, so tests must `app.close()` / `module.close()` to release Redis handles (Jest open-handle hygiene, see Phase 0.5).

## bullmq

**Source:** `/taskforcesh/bullmq/v6.5.3` (Context7, High reputation, 4.5k snippets). Maps to `TD-01`, `TD-04`, `TD-12`, `TD-13`.

### Job ids and dedupe (TD-13)

- `queue.add('process', { videoId }, { jobId: videoId })`: *"adding a job with an existing id will be ignored"*. A **retained completed or failed job also counts as existing**. The docs warn that with `removeOnComplete`/`removeOnFail` *"a removed job will not count as existing and a new job with the same job ID could be added"*.
- Avoid `:` and digit-only strings in custom ids. A UUID is fine.
- `queue.getJob(id)` returns the job or `undefined`. `job.getState()` returns `'completed' | 'failed' | 'active' | 'delayed' | 'prioritized' | 'waiting' | 'waiting-children' | 'unknown'`.
- `job.remove()` / `queue.remove(id)` **throws for locked (active) jobs**. Only remove `completed`/`failed` jobs (sweeper case (c)).

### Retries and terminal failure (TD-12)

```ts
defaultJobOptions: {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { count: 1000 },
}
```

- Throw `new UnrecoverableError(msg)` (from `bullmq`) for invalid media or thumbnail failures. The job then goes straight to failed with no retries.
- `job.attemptsMade` increments on every thrown error except `RateLimitError`, `DelayedError` and `WaitingChildrenError`. Final failure means `job.attemptsMade >= job.opts.attempts` or `err` is an `UnrecoverableError` (check `err.name === 'UnrecoverableError'` as well as `instanceof`).
- Worker `'failed'` listener signature: `(job: Job | undefined, error: Error, prev: string)`. **`job` can be `undefined`**, so the handler must tolerate it. The sweeper reconciles those cases.
- Stalled jobs: once a job stalls more than `maxStalledCount` (default **1**), it is *"failed permanently with the error 'job stalled more than allowable limit'"*. That is another route to a `failed` job without `process()` writing the status.

### Job Schedulers (TD-04 / TD-13 sweeper)

```ts
await queue.upsertJobScheduler(
  'video-sweeper',
  { every: sweeperIntervalMs },             // default 15 min (TD-13 revision)
  { name: 'sweep', data: {}, opts: {} },
);
```

`upsertJobScheduler` is idempotent by scheduler id, so it's safe to call on every worker boot. Per the testing guide, test the sweep **method** itself, not the schedule.

### Connections and production settings

- Workers need ioredis `maxRetriesPerRequest: null`. BullMQ sets it by default when given connection options. If you pass your own `IORedis` instance, set it yourself or BullMQ warns or throws.
- Redis `maxmemory-policy` must be `noeviction` (Going to production).
- BullMQ 6: `ioredis` (and `redis`, `pg`) are **optional peers**. Install `ioredis` explicitly.

## ioredis

**Source:** `/redis/ioredis` (Context7, versions v5.11.1 / v6.0.0). Used only as BullMQ's connection driver. No direct Redis commands are planned. Connection options come from the `redis` config namespace: `host` = Compose service name, `port` 6379. Pinned to `^5.11.1` (see summary).

## redis (Docker image)

Compose service `redis` with `image: redis:8.10.3-alpine` and `command: ["redis-server", "--maxmemory-policy", "noeviction"]`. Healthcheck: `redis-cli ping`. API, worker and tests reach it at `redis:6379`. Nothing uses `localhost` (IC-1 testing override, TD-01 revision).

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7, High reputation). Maps to `TD-02`, `TD-05`, `TD-06`, `TD-07`, `TD-09`, `TD-11`.

### Two clients behind one storage service (TD-06)

```ts
const common = {
  region: cfg.region,                       // any value for MinIO, e.g. "us-east-1"
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,                     // MinIO / Silo
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
} as const;
const internal = new S3Client({ ...common, endpoint: cfg.endpoint });        // http://minio:9000: all operations
const presign  = new S3Client({ ...common, endpoint: cfg.publicEndpoint });  // signing only (offline)
```

**Checksum gotcha (TD-02 revision).** The default `requestChecksumCalculation` is `WHEN_SUPPORTED`. For operations with a modelled `ChecksumAlgorithm` member (`PutObject`, `UploadPart`), the SDK then sets CRC32 by default and adds `x-amz-sdk-checksum-algorithm` / `x-amz-checksum-crc32`. With `WHEN_REQUIRED` it adds them only when the operation requires a checksum, which `UploadPart` and `PutObject` don't. Without the override, presigned part URLs can demand checksum headers the uploader cannot supply.

### Commands used

| Step | Command | Notes |
|---|---|---|
| Start (TD-03) | `CreateMultipartUploadCommand({ Bucket, Key: 'videos/{id}/original', ContentType })` | Persist `UploadId` on the row. If the DB insert fails, abort. |
| Sign parts | `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` + presigner | Public client; TTL 3600 s. |
| Resume | `ListPartsCommand({ Bucket, Key, UploadId, PartNumberMarker })` | Paginate with `IsTruncated` / `NextPartNumberMarker`. |
| Complete | `CompleteMultipartUploadCommand({ …, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` | Parts ascending. `InvalidPart`/`InvalidPartOrder` → 400. |
| Verify size | `HeadObjectCommand` → `ContentLength` | Compare with declared `size_bytes`. |
| Abort (user / sweeper) | `AbortMultipartUploadCommand` | Tolerate `NoSuchUpload`. |
| Thumbnail | `PutObjectCommand({ Key: 'videos/{id}/thumbnail.jpg', Body, ContentType: 'image/jpeg' })` | Internal client. |
| Bucket bootstrap | `HeadBucketCommand` / `CreateBucketCommand` | Idempotent (or a `pgsty/mc` init service). |

## @aws-sdk/s3-request-presigner

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
const url = await getSignedUrl(presign, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });
const stream = await getSignedUrl(presign, new GetObjectCommand({ Bucket, Key }), { expiresIn: 300 });
const download = await getSignedUrl(presign, new GetObjectCommand({
  Bucket, Key, ResponseContentDisposition: `attachment; filename="${safeName}"`,
}), { expiresIn: 300 });
```

- `expiresIn` defaults to **900 s** if omitted. Always pass it explicitly (TD-02: parts 1 h; TD-11: short-lived GET).
- Signing is offline: no connection to the public endpoint is needed, which is why the `localhost:9000` presign client works from inside the container.
- The SigV4 signature binds the host. URLs consumed **inside** containers (worker ffprobe/ffmpeg input, e2e tests) must be signed with the internal endpoint. In the test env, `S3_PUBLIC_ENDPOINT = S3_ENDPOINT = http://minio:9000` (TD-06 revision).
- `ResponseContentDisposition` is a signed query parameter. Sanitize/encode the filename (RFC 6266 `filename*=UTF-8''…` for non-ASCII).

## pgsty/silo + pgsty/mc (Docker images)

**Source:** `/minio/minio` (Context7, upstream MinIO docs; Silo is a drop-in fork). Maps to `TD-07`.

- Image `pgsty/silo:RELEASE.2026-10-26T00-00-00Z`. Command `server /data --console-address ":9001"`. Same `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` env vars. **The binary is `silo`**, so healthchecks must call it, or use `curl -f http://localhost:9000/minio/health/live` from inside the container if curl is present (distroless tags have no shell).
- Bucket bootstrap via `pgsty/mc:RELEASE.2026-10-26T00-00-00Z` one-shot: `mc alias set local http://minio:9000 …` then `mc mb --ignore-existing local/<bucket>`. Alternatively, an idempotent `CreateBucket` at startup.
- Storage-native backstop for TD-04: `api stale_uploads_expiry` (default 24h). No extra config is needed locally.
- CORS (`api cors_allow_origin`) only matters for a browser client (future frontend). For browser uploads, `ETag` must be exposed. Not needed for Phase 03 backend tests.

## ffmpeg / ffprobe (Debian apt)

**Source:** `/websites/ffmpeg_ffmpeg-all` (Context7; documents current FFmpeg **8.x**). Installed binary: **5.1.9** (bookworm). Options below verified on 5.1.9. Maps to `TD-09` and its AMB-2/AMB-3 revisions.

```bash
# worker Dockerfile
apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

# metadata (AMB-2)
ffprobe -v error -print_format json -show_format -show_streams "<internal presigned GET>"

# thumbnail (AMB-3), JPEG on stdout
ffmpeg -v error -ss <t> -i "<internal presigned GET>" -frames:v 1 \
  -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2" \
  -q:v 3 -f mjpeg pipe:1
```

- `-ss` **before** `-i` means input seeking: FFmpeg seeks with HTTP Range requests and doesn't decode from the start.
- `-frames:v 1` writes a single image. `-q:v` 2–5 is good JPEG quality for mjpeg.
- `scale` with `force_original_aspect_ratio=decrease` fits the box, and `force_divisible_by=2` keeps even dimensions. Both options are present in 5.1.9 (`ffmpeg -h filter=scale`, checked 2026-11-04). Using `min(...,iw/ih)` prevents upscaling.
- Call via `child_process.execFile` (no shell), with a `timeout` (120 s) and a `maxBuffer` large enough for the JPEG (10 MiB). A non-zero exit or empty stdout counts as a failed extraction (TD-09 revision fallback).
- ffprobe JSON fields used: `format.duration` (string, seconds), `streams[i].codec_type === 'video'`, `.width`, `.height`, `.codec_name`.
