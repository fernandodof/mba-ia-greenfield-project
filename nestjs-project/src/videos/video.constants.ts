// Fixed contract values (not env) — Data Model → Configuration.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// TD-02: S3 multipart, 64 MiB parts, at most 10 GiB per video.
export const VIDEO_MAX_SIZE_BYTES = 10 * GIB;
export const VIDEO_PART_SIZE_BYTES = 64 * MIB;
export const VIDEO_MAX_PART_COUNT = 160;

export const UPLOAD_PART_URL_TTL_SECONDS = 3600;
export const PLAYBACK_URL_TTL_SECONDS = 3600;
export const WORKER_SOURCE_URL_TTL_SECONDS = 900;

export const MEDIA_COMMAND_TIMEOUT_MS = 120000;
export const THUMBNAIL_MAX_BUFFER_BYTES = 10 * MIB;
// ffprobe JSON (`-show_format -show_streams`, with every tag) is held in
// memory by the worker. Node's 1 MiB default rejects valid media with large
// metadata; 32 MiB fits huge tags or thousands of streams while bounding
// the per-job peak (buffer + string + parsed object, ~3×) to ~100 MiB.
export const PROBE_MAX_BUFFER_BYTES = 32 * MIB;

export function computePartCount(sizeBytes: number): number {
  return Math.ceil(sizeBytes / VIDEO_PART_SIZE_BYTES);
}
