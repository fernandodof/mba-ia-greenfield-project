import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  InvalidUploadPartsError,
  UploadSessionNotFoundError,
} from './storage.errors';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface PresignGetObjectOptions {
  /** `internal` URLs are consumed inside Docker; `public` URLs are handed to clients. */
  client: 'internal' | 'public';
  expiresIn: number;
  responseContentDisposition?: string;
}

// Client-caused CompleteMultipartUpload rejections that leave the upload
// session intact: the client can re-upload parts and retry. `EntityTooSmall`
// means a part other than the last is under the 5 MiB S3 minimum.
const INVALID_PARTS_ERROR_NAMES = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
]);

/** S3 errors are matched by `err.name` (see library-refs.md → Error matching). */
function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

/**
 * Single entry point to object storage. It owns two S3 clients so callers
 * never pick an endpoint (TD-06): `internal` (S3_ENDPOINT) performs every
 * operation, `presign` (S3_PUBLIC_ENDPOINT) only signs URLs for clients
 * outside Docker — signing is offline, so it never connects.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly internal: S3Client;
  private readonly presign: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    const common: S3ClientConfig = {
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
      // The SDK default (WHEN_SUPPORTED) adds CRC32 checksums to UploadPart /
      // PutObject, which presigned part URLs could not satisfy (TD-02).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    this.internal = new S3Client({ ...common, endpoint: config.endpoint });
    this.presign = new S3Client({
      ...common,
      endpoint: config.publicEndpoint,
    });
    this.bucket = config.bucket;
  }

  onModuleDestroy(): void {
    this.internal.destroy();
    this.presign.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const output = await this.internal.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!output.UploadId) {
      throw new Error(`Storage returned no UploadId for key "${key}"`);
    }
    return output.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return await getSignedUrl(
      this.presign,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    try {
      do {
        const output = await this.internal.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of output.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            etag: part.ETag ?? '',
            size: part.Size ?? 0,
          });
        }
        marker = output.IsTruncated ? output.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (err) {
      throw this.toStorageError(err, key, uploadId);
    }
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.internal.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (err) {
      throw this.toStorageError(err, key, uploadId);
    }
  }

  /** Idempotent: an unknown, aborted or completed upload is a no-op (TD-03, TD-04). */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internal.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      if (errorName(err) === 'NoSuchUpload') {
        return;
      }
      throw err;
    }
  }

  /** Returns `null` when the object does not exist; any other error propagates. */
  async headObject(key: string): Promise<{ size: number } | null> {
    try {
      const output = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { size: output.ContentLength ?? 0 };
    } catch (err) {
      if (errorName(err) === 'NotFound') {
        return null;
      }
      throw err;
    }
  }

  /** Idempotent: deleting a missing key succeeds. */
  async deleteObject(key: string): Promise<void> {
    await this.internal.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignGetObject(
    key: string,
    options: PresignGetObjectOptions,
  ): Promise<string> {
    const client = options.client === 'internal' ? this.internal : this.presign;
    return await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  private toStorageError(err: unknown, key: string, uploadId: string): unknown {
    const name = errorName(err);
    if (name === 'NoSuchUpload') {
      return new UploadSessionNotFoundError(key, uploadId, { cause: err });
    }
    if (name !== undefined && INVALID_PARTS_ERROR_NAMES.has(name)) {
      return new InvalidUploadPartsError(key, uploadId, { cause: err });
    }
    return err;
  }
}
