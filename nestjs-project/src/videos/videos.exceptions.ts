import { DomainException } from '../common/exceptions/domain.exception';

// Error Catalog (phase-03-videos). Mapped to `{ statusCode, error, message }`
// by the global DomainExceptionFilter (phase-02-auth/TD-07).

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoUploadNotActiveException extends DomainException {
  constructor() {
    super('VIDEO_UPLOAD_NOT_ACTIVE', 409, 'Video has no active upload session');
  }
}

export class UploadPartsInvalidException extends DomainException {
  constructor() {
    super('UPLOAD_PARTS_INVALID', 400, 'Upload parts are invalid');
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      422,
      'Uploaded size does not match the declared size',
    );
  }
}
