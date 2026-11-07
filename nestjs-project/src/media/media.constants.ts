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
