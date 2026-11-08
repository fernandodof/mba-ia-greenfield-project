import { Inject, Injectable } from '@nestjs/common';
import {
  MEDIA_COMMAND_TIMEOUT_MS,
  PROBE_MAX_BUFFER_BYTES,
  THUMBNAIL_MAX_BUFFER_BYTES,
} from '../videos/video.constants';
import {
  EXEC_FILE,
  isTransientFfmpegStderr,
  MEDIA_INPUT_RESTRICTION_ARGS,
  type ExecFileFn,
} from './media.constants';
import { InvalidMediaError, TransientMediaError } from './media.errors';

export interface MediaProbeResult {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
}

/** Fits 1280×720, keeps the aspect ratio, never upscales, even sides (TD-09 AMB-3). */
const THUMBNAIL_SCALE_FILTER =
  "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";

const MAX_STDERR_IN_MESSAGE = 500;

/** Node's `execFile` rejection when stdout or stderr exceeds `maxBuffer`. */
const MAX_BUFFER_EXCEEDED = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/** Shape of the error a promisified `execFile` rejects with. */
interface ExecFileFailure {
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
  stderr?: Buffer | string;
}

interface ProbeOutput {
  format?: { duration?: unknown };
  streams?: Array<{
    codec_type?: unknown;
    codec_name?: unknown;
    width?: unknown;
    height?: unknown;
  }>;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Runs ffprobe/ffmpeg (no shell) against a presigned HTTP URL, so the
 * original is never copied locally (TD-09), and classifies failures as
 * transient (retry) or permanent. Every input is restricted to the
 * whitelisted protocols and demuxers, so uploaded content (e.g. an HLS
 * playlist) can never make the worker fetch other URLs; a refused input
 * fails with `Invalid argument`, i.e. as invalid media.
 */
@Injectable()
export class FfmpegService {
  constructor(@Inject(EXEC_FILE) private readonly execFile: ExecFileFn) {}

  async probe(url: string): Promise<MediaProbeResult> {
    let stdout: Buffer;
    try {
      ({ stdout } = await this.execFile(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          ...MEDIA_INPUT_RESTRICTION_ARGS,
          url,
        ],
        {
          encoding: 'buffer',
          timeout: MEDIA_COMMAND_TIMEOUT_MS,
          maxBuffer: PROBE_MAX_BUFFER_BYTES,
        },
      ));
    } catch (err) {
      // ffprobe's output is a deterministic function of the file, so a retry
      // would overflow again: permanent, unlike other non-exit failures.
      if ((err as ExecFileFailure | null)?.code === MAX_BUFFER_EXCEEDED) {
        throw new InvalidMediaError(
          `ffprobe output exceeds ${PROBE_MAX_BUFFER_BYTES} bytes`,
          { cause: err },
        );
      }
      const stderr = this.failureStderr(err, url, 'ffprobe');
      throw new InvalidMediaError(`ffprobe failed: ${stderr}`, { cause: err });
    }
    return this.parseProbeOutput(stdout);
  }

  /** JPEG frame at `t` seconds, or `null` when ffmpeg yields no frame (caller decides the fallback). */
  async extractFrame(url: string, t: number): Promise<Buffer | null> {
    let stdout: Buffer;
    try {
      ({ stdout } = await this.execFile(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          String(t),
          ...MEDIA_INPUT_RESTRICTION_ARGS,
          '-i',
          url,
          '-frames:v',
          '1',
          '-vf',
          THUMBNAIL_SCALE_FILTER,
          '-q:v',
          '3',
          '-f',
          'mjpeg',
          'pipe:1',
        ],
        {
          encoding: 'buffer',
          timeout: MEDIA_COMMAND_TIMEOUT_MS,
          maxBuffer: THUMBNAIL_MAX_BUFFER_BYTES,
        },
      ));
    } catch (err) {
      this.failureStderr(err, url, 'ffmpeg');
      return null;
    }
    return stdout.length > 0 ? stdout : null;
  }

  /**
   * Throws for every failure that is not a permanent media problem: a
   * timeout or transient stderr → `TransientMediaError`; anything that is not
   * a process exit (spawn error, maxBuffer overflow, foreign signal) is
   * rethrown as-is (`probe` handles its own overflow before calling this). Returns the (redacted) stderr of a non-transient exit.
   */
  private failureStderr(err: unknown, url: string, command: string): string {
    const failure = (err ?? {}) as ExecFileFailure;
    if (failure.killed === true || failure.code === 'ETIMEDOUT') {
      throw new TransientMediaError(
        `${command} timed out after ${MEDIA_COMMAND_TIMEOUT_MS} ms`,
        { cause: err },
      );
    }
    if (typeof failure.code !== 'number') {
      throw err;
    }
    const stderr = this.redact(String(failure.stderr ?? ''), url);
    if (isTransientFfmpegStderr(stderr)) {
      throw new TransientMediaError(`${command} failed: ${stderr}`, {
        cause: err,
      });
    }
    return stderr;
  }

  /** Keeps the presigned signature out of error messages (they end up in Redis). */
  private redact(stderr: string, url: string): string {
    const bare = url.split('?')[0];
    return stderr.split(url).join(bare).trim().slice(0, MAX_STDERR_IN_MESSAGE);
  }

  private parseProbeOutput(stdout: Buffer): MediaProbeResult {
    let output: ProbeOutput;
    try {
      output = JSON.parse(stdout.toString('utf8')) as ProbeOutput;
    } catch (err) {
      throw new InvalidMediaError('ffprobe returned unparsable JSON', {
        cause: err,
      });
    }

    const stream = output.streams?.find((s) => s.codec_type === 'video');
    if (!stream) {
      throw new InvalidMediaError('No video stream found');
    }

    const duration = Number(output.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new InvalidMediaError('Missing or non-positive duration');
    }

    const { width, height, codec_name: codec } = stream;
    if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
      throw new InvalidMediaError('Video stream has no valid dimensions');
    }
    if (typeof codec !== 'string' || codec.length === 0) {
      throw new InvalidMediaError('Video stream has no codec name');
    }

    return {
      durationMs: Math.round(duration * 1000),
      width,
      height,
      videoCodec: codec,
    };
  }
}
