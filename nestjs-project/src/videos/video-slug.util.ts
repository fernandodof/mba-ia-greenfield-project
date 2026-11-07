import { randomBytes } from 'node:crypto';

const VIDEO_SLUG_BYTES = 8;

// TD-10: 64 random bits as unpadded base64url = 11 URL-safe characters.
// Uniqueness is enforced by the DB constraint plus a retry in the service.
export function generateVideoSlug(): string {
  return randomBytes(VIDEO_SLUG_BYTES).toString('base64url');
}
