import { randomBytes } from 'node:crypto';

const VIDEO_SLUG_BYTES = 8;

// TD-10: 64 random bits as unpadded base64url = 11 URL-safe characters.
// Uniqueness is enforced by the DB constraint plus a retry in the service.
export function generateVideoSlug(): string {
  return randomBytes(VIDEO_SLUG_BYTES).toString('base64url');
}

const VIDEO_SLUG_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// True only for the shape `generateVideoSlug` produces. Anything else cannot
// name a video, so callers can answer "not found" without a DB round trip
// (and never send NUL or other bytes PostgreSQL rejects to a query).
export function isVideoSlug(value: string): boolean {
  return VIDEO_SLUG_PATTERN.test(value);
}
