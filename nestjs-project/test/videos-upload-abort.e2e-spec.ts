import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { UploadSessionNotFoundError } from '../src/storage/storage.errors';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { originalKey } from '../src/videos/video-storage-keys';
import { VideoStatus } from '../src/videos/video.types';
import {
  createAuthenticatedUser,
  type AuthenticatedUser,
} from './helpers/authenticated-user';

// Spec: specs/videos-upload-abort.plan.md (SI-03.8). Real Postgres, Redis and
// minio via Compose service names; the Jest setup file sets
// S3_PUBLIC_ENDPOINT = S3_ENDPOINT, so signed URLs can be PUT from here.

interface UploadSessionBody {
  id: string;
}

interface SignedPartsBody {
  parts: { partNumber: number; url: string }[];
}

interface VideoBody {
  status: string;
  failureReason: string | null;
}

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

const VIDEO_BODY = {
  filename: 'clip.mp4',
  size: 1048576,
  contentType: 'video/mp4',
};

const UPLOAD_NOT_ACTIVE = {
  statusCode: 409,
  error: 'VIDEO_UPLOAD_NOT_ACTIVE',
  message: 'Video has no active upload session',
};

describe('videos-upload-abort', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let videoRepository: Repository<Video>;
  let userA: AuthenticatedUser;
  let userB: AuthenticatedUser;
  let videoId: string;
  let uploadId: string;
  let key: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    userA = await createAuthenticatedUser(app, dataSource, 'owner@example.com');
    userB = await createAuthenticatedUser(app, dataSource, 'other@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send(VIDEO_BODY)
      .expect(201);
    videoId = (res.body as UploadSessionBody).id;
    key = originalKey(videoId);
    uploadId = (await videoRepository.findOneByOrFail({ id: videoId }))
      .upload_id!;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Rows that still carry an upload_id may keep a multipart session open in
  // minio (aborting one that is already gone is a no-op); originals left by a
  // test are removed too.
  async function abortOpenUploads(): Promise<void> {
    const rows = await videoRepository.find({
      where: { upload_id: Not(IsNull()) },
    });
    for (const row of rows) {
      await storage.abortMultipartUpload(originalKey(row.id), row.upload_id!);
    }
    for (const row of await videoRepository.find()) {
      await storage.deleteObject(originalKey(row.id));
    }
  }

  function abort(id: string, token?: string): request.Test {
    const req = request(app.getHttpServer()).delete(`/videos/${id}/upload`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  async function findRow(): Promise<Video> {
    return videoRepository.findOneByOrFail({ id: videoId });
  }

  // 1. DELETE /videos/:id/upload

  it('abort-draft-marks-failed-upload-aborted', async () => {
    const res = await abort(videoId, userA.accessToken).expect(204);
    expect(res.text).toBe('');

    expect(await findRow()).toEqual(
      expect.objectContaining({
        status: VideoStatus.FAILED,
        failure_reason: 'UPLOAD_ABORTED',
        upload_id: null,
      }),
    );

    const read = await request(app.getHttpServer())
      .get(`/videos/${videoId}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);
    expect(read.body as VideoBody).toEqual(
      expect.objectContaining({
        status: 'failed',
        failureReason: 'UPLOAD_ABORTED',
      }),
    );
  });

  it('abort-releases-multipart-upload-and-original-object', async () => {
    const signed = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ partNumbers: [1] })
      .expect(200);
    const put = await fetch((signed.body as SignedPartsBody).parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(randomBytes(1024)),
    });
    expect(put.status).toBe(200);
    await storage.putObject(key, randomBytes(16), 'video/mp4');

    await abort(videoId, userA.accessToken).expect(204);

    await expect(storage.listParts(key, uploadId)).rejects.toBeInstanceOf(
      UploadSessionNotFoundError,
    );
    await expect(storage.headObject(key)).resolves.toBeNull();
  });

  it('abort-tolerates-already-gone-storage-upload', async () => {
    await storage.abortMultipartUpload(key, uploadId);
    expect((await findRow()).status).toBe(VideoStatus.DRAFT);

    await abort(videoId, userA.accessToken).expect(204);

    expect(await findRow()).toEqual(
      expect.objectContaining({
        status: VideoStatus.FAILED,
        failure_reason: 'UPLOAD_ABORTED',
        upload_id: null,
      }),
    );
  });

  it('abort-rejects-non-draft-video-without-storage-calls', async () => {
    const abortSpy = jest.spyOn(storage, 'abortMultipartUpload');
    const deleteSpy = jest.spyOn(storage, 'deleteObject');
    const seeded = [
      { status: VideoStatus.PROCESSING, failure_reason: null },
      { status: VideoStatus.READY, failure_reason: null },
      { status: VideoStatus.FAILED, failure_reason: 'PROCESSING_FAILED' },
    ] as const;

    for (const state of seeded) {
      await videoRepository.update(
        { id: videoId },
        { status: state.status, failure_reason: state.failure_reason },
      );

      const res = await abort(videoId, userA.accessToken).expect(409);

      expect(res.body as ErrorResponseBody).toEqual(UPLOAD_NOT_ACTIVE);
      expect(await findRow()).toEqual(
        expect.objectContaining({
          status: state.status,
          failure_reason: state.failure_reason,
        }),
      );
    }
    expect(abortSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('second-abort-returns-409', async () => {
    await abort(videoId, userA.accessToken).expect(204);

    const res = await abort(videoId, userA.accessToken).expect(409);

    expect((res.body as ErrorResponseBody).error).toBe(
      'VIDEO_UPLOAD_NOT_ACTIVE',
    );
    expect((await findRow()).failure_reason).toBe('UPLOAD_ABORTED');
  });

  it('abort-loses-race-to-concurrent-complete', async () => {
    jest
      .spyOn(storage, 'deleteObject')
      .mockImplementationOnce(async (objectKey: string) => {
        // A concurrent `complete` wins right after the draft pre-check.
        await videoRepository.update(
          { id: videoId },
          {
            status: VideoStatus.PROCESSING,
            upload_id: null,
            processing_started_at: new Date(),
          },
        );
        // The once-implementation is already consumed, so this re-entrant
        // call goes through the spy's default: the real deleteObject.
        await storage.deleteObject(objectKey);
      });

    const res = await abort(videoId, userA.accessToken).expect(409);

    expect((res.body as ErrorResponseBody).error).toBe(
      'VIDEO_UPLOAD_NOT_ACTIVE',
    );
    expect(await findRow()).toEqual(
      expect.objectContaining({
        status: VideoStatus.PROCESSING,
        failure_reason: null,
      }),
    );
  });

  it('abort-hides-other-users-video', async () => {
    const foreign = await abort(videoId, userB.accessToken).expect(404);
    expect((foreign.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
    expect(await findRow()).toEqual(
      expect.objectContaining({
        status: VideoStatus.DRAFT,
        upload_id: uploadId,
      }),
    );
    await expect(storage.listParts(key, uploadId)).resolves.toEqual([]);

    const unknown = await abort(randomUUID(), userA.accessToken).expect(404);
    expect((unknown.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
  });

  it('abort-rejects-malformed-id-and-missing-token', async () => {
    const malformed = await abort('not-a-uuid', userA.accessToken).expect(400);
    expect((malformed.body as ErrorResponseBody).error).toBe(
      'VALIDATION_ERROR',
    );

    await abort(videoId).expect(401);
    expect((await findRow()).status).toBe(VideoStatus.DRAFT);
  });
});
