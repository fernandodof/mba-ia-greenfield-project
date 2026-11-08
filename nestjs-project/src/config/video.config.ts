import { registerAs } from '@nestjs/config';

// Fallbacks mirror the Joi defaults in env.validation.ts.
export default registerAs('video', () => ({
  workerConcurrency: parseInt(process.env.VIDEO_WORKER_CONCURRENCY || '1', 10),
  sweeperIntervalMs: parseInt(
    process.env.VIDEO_SWEEPER_INTERVAL_MS || '900000',
    10,
  ),
  processingStuckAfterMs: parseInt(
    process.env.VIDEO_PROCESSING_STUCK_AFTER_MS || '1800000',
    10,
  ),
  uploadExpireAfterMs: parseInt(
    process.env.VIDEO_UPLOAD_EXPIRE_AFTER_MS || '86400000',
    10,
  ),
}));
