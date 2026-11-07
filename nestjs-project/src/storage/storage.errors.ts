// Storage errors are plain Errors on purpose: the storage layer stays
// transport- and domain-agnostic. Callers (e.g. VideosService) translate
// them into their own domain exceptions.

/** The multipart upload session does not exist (S3 `NoSuchUpload`). */
export class UploadSessionNotFoundError extends Error {
  constructor(
    readonly key: string,
    readonly uploadId: string,
    options?: ErrorOptions,
  ) {
    super(`Upload session not found for key "${key}"`, options);
    this.name = 'UploadSessionNotFoundError';
  }
}

/** The parts sent to complete an upload were rejected (S3 `InvalidPart` / `InvalidPartOrder`). */
export class InvalidUploadPartsError extends Error {
  constructor(
    readonly key: string,
    readonly uploadId: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid upload parts for key "${key}"`, options);
    this.name = 'InvalidUploadPartsError';
  }
}
