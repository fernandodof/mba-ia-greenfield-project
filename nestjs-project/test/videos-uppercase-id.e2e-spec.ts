import { randomBytes } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
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
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../src/videos/video-queue.constants';
import { originalKey } from '../src/videos/video-storage-keys';
import { VideoStatus } from '../src/videos/video.types';
import {
  createAuthenticatedUser,
  type AuthenticatedUser,
} from './helpers/authenticated-user';

// Post-QA regression (bug 2): ParseUUIDPipe accepts an uppercase UUID and
// Postgres matches it, so every `:id` upload route must behave exactly as with
// the canonical lowercase id: storage keys, job ids and status writes use the
// loaded row's id. Real Postgres, Redis (QUEUE_PREFIX=bull-test) and minio.

interface UploadSessionBody {
  id: string;
  slug: string;
}

interface SignedPartsBody {
  parts: { partNumber: number; url: string }[];
}

interface UploadedPartsBody {
  parts: { partNumber: number; etag: string; size: number }[];
}

describe('videos-uppercase-id', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue<VideoProcessingJobData>;
  let videoRepository: Repository<Video>;
  let owner: AuthenticatedUser;

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
    queue = app.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await releaseStorage();
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await releaseStorage();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await queue.obliterate({ force: true });
    owner = await createAuthenticatedUser(app, dataSource, 'owner@example.com');
  });

  // Aborts sessions still referenced by a row and deletes any original, under
  // both the canonical and the uppercase key (aborting a gone session is a
  // no-op).
  async function releaseStorage(): Promise<void> {
    const open = await videoRepository.find({
      where: { upload_id: Not(IsNull()) },
    });
    for (const row of open) {
      await storage.abortMultipartUpload(originalKey(row.id), row.upload_id!);
    }
    for (const row of await videoRepository.find()) {
      await storage.deleteObject(originalKey(row.id));
      await storage.deleteObject(originalKey(row.id.toUpperCase()));
    }
  }

  async function startUpload(size: number): Promise<UploadSessionBody> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', size })
      .expect(201);
    return res.body as UploadSessionBody;
  }

  async function signPart(id: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/parts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ partNumbers: [1] })
      .expect(200);
    return (res.body as SignedPartsBody).parts[0].url;
  }

  async function putPart(url: string, bytes: Buffer): Promise<string> {
    const put = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
    return put.headers.get('etag')!;
  }

  it('sign-with-uppercase-id-signs-the-canonical-key-and-put-succeeds', async () => {
    const { id } = await startUpload(1024);

    const url = await signPart(id.toUpperCase());

    expect(new URL(url).pathname).toContain(`/videos/${id}/original`);
    expect(url).not.toContain(id.toUpperCase());
    await putPart(url, randomBytes(1024));
    const row = await videoRepository.findOneByOrFail({ id });
    await expect(
      storage.listParts(originalKey(id), row.upload_id!),
    ).resolves.toHaveLength(1);
  });

  it('list-parts-with-uppercase-id-returns-200', async () => {
    const { id } = await startUpload(1024);
    const etag = await putPart(await signPart(id), randomBytes(1024));

    const res = await request(app.getHttpServer())
      .get(`/videos/${id.toUpperCase()}/upload/parts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect((res.body as UploadedPartsBody).parts).toEqual([
      expect.objectContaining({ partNumber: 1, etag, size: 1024 }),
    ]);
  });

  it('abort-with-uppercase-id-releases-the-real-session', async () => {
    const { id } = await startUpload(1024);
    await putPart(await signPart(id), randomBytes(1024));
    const { upload_id: uploadId } = await videoRepository.findOneByOrFail({
      id,
    });

    await request(app.getHttpServer())
      .delete(`/videos/${id.toUpperCase()}/upload`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    await expect(
      storage.listParts(originalKey(id), uploadId!),
    ).rejects.toBeInstanceOf(UploadSessionNotFoundError);
    await expect(storage.headObject(originalKey(id))).resolves.toBeNull();
    const row = await videoRepository.findOneByOrFail({ id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.failure_reason).toBe('UPLOAD_ABORTED');
    expect(row.upload_id).toBeNull();
  });

  it('complete-with-uppercase-id-keeps-a-single-canonical-job', async () => {
    const { id, slug } = await startUpload(1024);
    const etag = await putPart(await signPart(id), randomBytes(1024));
    const parts = [{ partNumber: 1, etag }];
    const expected = { id, slug, status: 'processing' };

    const first = await request(app.getHttpServer())
      .post(`/videos/${id.toUpperCase()}/upload/complete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ parts })
      .expect(200);
    const second = await request(app.getHttpServer())
      .post(`/videos/${id.toUpperCase()}/upload/complete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ parts })
      .expect(200);

    expect(first.body).toEqual(expected);
    expect(second.body).toEqual(expected);
    const jobs = await queue.getJobs();
    expect(jobs.map((job) => job.id)).toEqual([id]);
    expect(jobs[0].data).toEqual({ videoId: id });
    await expect(queue.getJob(id.toUpperCase())).resolves.toBeUndefined();
    await expect(storage.headObject(originalKey(id))).resolves.toEqual({
      size: 1024,
    });
    const row = await videoRepository.findOneByOrFail({ id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
  });
});
