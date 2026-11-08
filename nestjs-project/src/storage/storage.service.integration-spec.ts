import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  InvalidUploadPartsError,
  UploadSessionNotFoundError,
} from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService, type CompletedPart } from './storage.service';

// Runs against the real `minio` Compose service (Phase 03 testing override
// IC-1). The Jest setup file sets S3_PUBLIC_ENDPOINT = S3_ENDPOINT so URLs
// signed by the presign client are reachable from inside the container.

const EXPIRES_IN = 3600;
const MIN_PART_SIZE = 5 * 1024 * 1024; // S3 minimum for every part but the last
const LAST_PART_SIZE = 1024;
const CONTENT_TYPE = 'video/mp4';
// Signing is offline, so this host never has to resolve.
const PUBLIC_ENDPOINT = 'http://storage.public.test:9000';

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let config: ConfigType<typeof storageConfig>;
  const createdKeys: string[] = [];

  const newKey = (): string => {
    const key = `videos/${randomUUID()}/original`;
    createdKeys.push(key);
    return key;
  };

  const putPart = async (url: string, bytes: Buffer): Promise<string> => {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  };

  const uploadParts = async (
    key: string,
    uploadId: string,
    sizes: number[],
  ): Promise<CompletedPart[]> => {
    const parts: CompletedPart[] = [];
    for (const [index, size] of sizes.entries()) {
      const partNumber = index + 1;
      const url = await storage.presignUploadPart(
        key,
        uploadId,
        partNumber,
        EXPIRES_IN,
      );
      parts.push({ partNumber, etag: await putPart(url, randomBytes(size)) });
    }
    return parts;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
    config = module.get(storageConfig.KEY);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await module.close();
  });

  describe('multipart upload', () => {
    it('should sign part URLs that accept a plain PUT and carry no checksum params', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, CONTENT_TYPE);

      const url = await storage.presignUploadPart(key, uploadId, 1, EXPIRES_IN);
      const etag = await putPart(url, randomBytes(LAST_PART_SIZE));

      const params = [...new URL(url).searchParams.keys()].map((name) =>
        name.toLowerCase(),
      );
      expect(params).not.toContain('x-amz-sdk-checksum-algorithm');
      expect(
        params.filter((name) => name.startsWith('x-amz-checksum-')),
      ).toEqual([]);
      expect(etag).toMatch(/^".+"$/);
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should list uploaded parts and complete them into an object of the summed size', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, CONTENT_TYPE);
      const parts = await uploadParts(key, uploadId, [
        MIN_PART_SIZE,
        LAST_PART_SIZE,
      ]);

      const listed = await storage.listParts(key, uploadId);
      await storage.completeMultipartUpload(key, uploadId, parts);
      const head = await storage.headObject(key);

      expect(listed).toEqual([
        { partNumber: 1, etag: parts[0].etag, size: MIN_PART_SIZE },
        { partNumber: 2, etag: parts[1].etag, size: LAST_PART_SIZE },
      ]);
      expect(head).toEqual({ size: MIN_PART_SIZE + LAST_PART_SIZE });
    });

    it('should reject a bogus ETag with InvalidUploadPartsError', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, CONTENT_TYPE);
      await uploadParts(key, uploadId, [LAST_PART_SIZE]);

      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(InvalidUploadPartsError);
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should reject a non-last part under 5 MiB (EntityTooSmall) with InvalidUploadPartsError', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, CONTENT_TYPE);
      const parts = await uploadParts(key, uploadId, [1, 1]);

      const error: unknown = await storage
        .completeMultipartUpload(key, uploadId, parts)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(InvalidUploadPartsError);
      expect((error as InvalidUploadPartsError).cause).toMatchObject({
        name: 'EntityTooSmall',
      });
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should keep the session usable after EntityTooSmall so a corrected retry completes', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, CONTENT_TYPE);
      const tooSmall = await uploadParts(key, uploadId, [1, 1]);
      await expect(
        storage.completeMultipartUpload(key, uploadId, tooSmall),
      ).rejects.toBeInstanceOf(InvalidUploadPartsError);

      const url = await storage.presignUploadPart(key, uploadId, 1, EXPIRES_IN);
      const etag = await putPart(url, randomBytes(MIN_PART_SIZE));
      await storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag },
        tooSmall[1],
      ]);

      expect(await storage.headObject(key)).toEqual({
        size: MIN_PART_SIZE + 1,
      });
    });

    it('should throw UploadSessionNotFoundError when listing parts of an aborted upload', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, CONTENT_TYPE);
      await storage.abortMultipartUpload(key, uploadId);

      await expect(storage.listParts(key, uploadId)).rejects.toBeInstanceOf(
        UploadSessionNotFoundError,
      );
    });

    it('should throw UploadSessionNotFoundError when completing an aborted upload', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, CONTENT_TYPE);
      const parts = await uploadParts(key, uploadId, [LAST_PART_SIZE]);
      await storage.abortMultipartUpload(key, uploadId);

      await expect(
        storage.completeMultipartUpload(key, uploadId, parts),
      ).rejects.toBeInstanceOf(UploadSessionNotFoundError);
    });

    it('should resolve when aborting an unknown upload', async () => {
      await expect(
        storage.abortMultipartUpload(newKey(), randomUUID()),
      ).resolves.toBeUndefined();
    });

    it('should resolve when aborting an already completed upload', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, CONTENT_TYPE);
      const parts = await uploadParts(key, uploadId, [LAST_PART_SIZE]);
      await storage.completeMultipartUpload(key, uploadId, parts);

      await expect(
        storage.abortMultipartUpload(key, uploadId),
      ).resolves.toBeUndefined();
      expect(await storage.headObject(key)).toEqual({ size: LAST_PART_SIZE });
    });
  });

  describe('objects', () => {
    it('should answer a ranged internal presigned GET with 206 and exactly the range', async () => {
      const key = newKey();
      const body = randomBytes(LAST_PART_SIZE);
      await storage.putObject(key, body, CONTENT_TYPE);

      const url = await storage.presignGetObject(key, {
        client: 'internal',
        expiresIn: EXPIRES_IN,
      });
      const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });
      const bytes = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(206);
      expect(bytes).toEqual(body.subarray(0, 100));
      expect(response.headers.get('content-type')).toBe(CONTENT_TYPE);
    });

    it('should apply responseContentDisposition to a presigned GET', async () => {
      const key = newKey();
      await storage.putObject(key, randomBytes(LAST_PART_SIZE), CONTENT_TYPE);
      const disposition = 'attachment; filename="clip.mp4"';

      const url = await storage.presignGetObject(key, {
        client: 'internal',
        expiresIn: EXPIRES_IN,
        responseContentDisposition: disposition,
      });
      const response = await fetch(url);
      await response.arrayBuffer();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(disposition);
    });

    it('should return null from headObject after deleteObject', async () => {
      const key = newKey();
      await storage.putObject(key, randomBytes(LAST_PART_SIZE), 'image/jpeg');
      expect(await storage.headObject(key)).toEqual({ size: LAST_PART_SIZE });

      await storage.deleteObject(key);

      expect(await storage.headObject(key)).toBeNull();
    });

    it('should succeed when deleting a missing key', async () => {
      await expect(storage.deleteObject(newKey())).resolves.toBeUndefined();
    });
  });

  describe('endpoint selection', () => {
    let publicModule: TestingModule;
    let publicStorage: StorageService;

    beforeAll(async () => {
      publicModule = await Test.createTestingModule({
        providers: [
          StorageService,
          {
            provide: storageConfig.KEY,
            useValue: { ...config, publicEndpoint: PUBLIC_ENDPOINT },
          },
        ],
      }).compile();
      publicStorage = publicModule.get(StorageService);
    });

    afterAll(async () => {
      await publicModule.close();
    });

    it('should sign part URLs and public GET URLs for the S3_PUBLIC_ENDPOINT host', async () => {
      const key = `videos/${randomUUID()}/original`;
      const publicHost = new URL(PUBLIC_ENDPOINT).host;

      const partUrl = await publicStorage.presignUploadPart(
        key,
        'upload-id',
        1,
        EXPIRES_IN,
      );
      const getUrl = await publicStorage.presignGetObject(key, {
        client: 'public',
        expiresIn: EXPIRES_IN,
      });

      expect(new URL(partUrl).host).toBe(publicHost);
      expect(new URL(getUrl).host).toBe(publicHost);
    });

    it('should sign internal GET URLs for the S3_ENDPOINT host', async () => {
      const url = await publicStorage.presignGetObject(
        `videos/${randomUUID()}/original`,
        { client: 'internal', expiresIn: EXPIRES_IN },
      );

      expect(new URL(url).host).toBe(new URL(config.endpoint).host);
    });
  });
});
