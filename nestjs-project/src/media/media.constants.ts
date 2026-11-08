import type { ExecFileOptions } from 'node:child_process';

/**
 * FFmpeg `http`/`tcp` protocol messages that mean the storage read failed,
 * not the media itself (TD-09 AMB-10). Matched case-insensitively against
 * the stderr of a non-zero ffprobe/ffmpeg exit; a match is retried.
 */
export const TRANSIENT_FFMPEG_STDERR_PATTERNS = [
  'Connection refused',
  'Connection reset',
  'timed out',
  'Server returned 5',
  'Server returned 403',
  'Input/output error',
  'I/O error',
  'Failed to resolve hostname',
] as const;

/**
 * Protocols ffprobe/ffmpeg may open for the input: only what the presigned
 * source URL needs (`http` over `tcp`; `https` over `tls` for deployments
 * where `S3_ENDPOINT` is https). `file`, `concat`, `subfile`, `data`, etc.
 * are refused.
 */
export const MEDIA_INPUT_PROTOCOL_WHITELIST = [
  'http',
  'https',
  'tcp',
  'tls',
] as const;

/**
 * Demuxers ffprobe/ffmpeg may use for the input: the containers that the
 * accepted `video/*` uploads map to (MP4/MOV/3GP, Matroska/WebM, AVI, FLV,
 * MPEG-TS, MPEG-PS, ASF/WMV, Ogg, MXF). None of them opens nested inputs, so
 * `hls`, `dash`, `concat`/ffconcat, `image2` and the like are refused before
 * they can fetch URLs taken from the uploaded content (SSRF). FFmpeg matches
 * any comma-separated part of a demuxer name (`mov` covers
 * `mov,mp4,m4a,3gp,3g2,mj2`).
 */
export const MEDIA_INPUT_FORMAT_WHITELIST = [
  'mov',
  'mp4',
  'matroska',
  'webm',
  'avi',
  'flv',
  'mpegts',
  'mpeg',
  'asf',
  'ogg',
  'mxf',
] as const;

/** Input options placed before the URL in every ffprobe/ffmpeg call. */
export const MEDIA_INPUT_RESTRICTION_ARGS = [
  '-protocol_whitelist',
  MEDIA_INPUT_PROTOCOL_WHITELIST.join(','),
  '-format_whitelist',
  MEDIA_INPUT_FORMAT_WHITELIST.join(','),
] as const;

/** Injection token for the promisified `child_process.execFile` (no shell). */
export const EXEC_FILE = Symbol('EXEC_FILE');

export type ExecFileBufferOptions = ExecFileOptions & { encoding: 'buffer' };

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileBufferOptions,
) => Promise<{ stdout: Buffer; stderr: Buffer }>;

export function isTransientFfmpegStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return TRANSIENT_FFMPEG_STDERR_PATTERNS.some((pattern) =>
    normalized.includes(pattern.toLowerCase()),
  );
}
