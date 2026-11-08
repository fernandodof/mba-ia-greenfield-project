// Media errors are plain Errors: the media layer knows nothing about jobs or
// videos. The worker (SI-03.13) maps them to retries or unrecoverable
// failure reasons.

/** ffprobe/ffmpeg timed out or reported a storage/network failure; retry. */
export class TransientMediaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientMediaError';
  }
}

/** The source is not usable media; retrying cannot help. */
export class InvalidMediaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidMediaError';
  }
}
