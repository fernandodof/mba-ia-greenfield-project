/** Processing lifecycle of a video (TD-12): `draft → processing → ready | failed`. */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/** Why a video ended in `failed`. Stored as `varchar(32)`, not a PG enum (TD-12). */
export type VideoFailureReason =
  | 'UPLOAD_EXPIRED'
  | 'UPLOAD_ABORTED'
  | 'UPLOAD_SIZE_MISMATCH'
  | 'INVALID_MEDIA'
  | 'THUMBNAIL_FAILED'
  | 'SOURCE_MISSING'
  | 'PROCESSING_FAILED';
