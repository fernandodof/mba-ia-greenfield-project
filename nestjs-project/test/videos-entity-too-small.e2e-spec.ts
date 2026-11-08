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
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_PART_SIZE_BYTES } from '../src/videos/video.constants';
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

// Post-QA regression (bug 3): every part but the last must be >= 5 MiB, so
// storage rejects a complete with undersized parts (`EntityTooSmall`). That
// is a fixable client error: 400 UPLOAD_PARTS_INVALID, the video stays
// `draft` with its session, and re-uploading the parts lets a retry succeed.
// Real Postgres, Redis (QUEUE_PREFIX=bull-test) and minio.

interface UploadSessionBody {
  id: string;
  slug: string;
  partCount: number;
}

interface SignedPartsBody {
  parts: { partNumber: number; url: string }[];
}

// 64 MiB + 1 byte → two parts.
const DECLARED_SIZE = VIDEO_PART_SIZE_BYTES + 1;

describe('videos-entity-too-small', () => {
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

  // Aborts sessions still referenced by a row and deletes leftover originals.
  async function releaseStorage(): Promise<void> {
    const open = await videoRepository.find({
      where: { upload_id: Not(IsNull()) },
    });
    for (const row of open) {
      await storage.abortMultipartUpload(originalKey(row.id), row.upload_id!);
    }
    for (const row of await videoRepository.find()) {
      await storage.deleteObject(originalKey(row.id));
    }
  }

  async function signParts(
    id: string,
    partNumbers: number[],
  ): Promise<SignedPartsBody['parts']> {
    const res = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/parts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ partNumbers })
      .expect(200);
    return (res.body as SignedPartsBody).parts;
  }

  async function putPart(url: string, size: number): Promise<string> {
    const res = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(randomBytes(size)),
    });
    expect(res.status).toBe(200);
    return res.headers.get('etag')!;
  }

  function complete(
    id: string,
    parts: { partNumber: number; etag: string }[],
  ): request.Test {
    return request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ parts });
  }

  it('complete-rejects-undersized-parts-and-allows-a-corrected-retry', async () => {
    const started = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        size: DECLARED_SIZE,
      })
      .expect(201);
    const { id, slug, partCount } = started.body as UploadSessionBody;
    expect(partCount).toBe(2);

    // QA repro: one byte in each part.
    const [first, second] = await signParts(id, [1, 2]);
    const tinyFirst = await putPart(first.url, 1);
    const lastEtag = await putPart(second.url, 1);

    const rejected = await complete(id, [
      { partNumber: 1, etag: tinyFirst },
      { partNumber: 2, etag: lastEtag },
    ]).expect(400);

    expect(rejected.body).toEqual({
      statusCode: 400,
      error: 'UPLOAD_PARTS_INVALID',
      message: 'Upload parts are invalid',
    });
    const draft = await videoRepository.findOneByOrFail({ id });
    expect(draft.status).toBe(VideoStatus.DRAFT);
    expect(draft.failure_reason).toBeNull();
    expect(draft.upload_id).toEqual(expect.any(String));
    await expect(queue.getJob(id)).resolves.toBeUndefined();

    // Corrected retry on the same session: a full part 1, the same last part.
    const [resigned] = await signParts(id, [1]);
    const fullFirst = await putPart(resigned.url, VIDEO_PART_SIZE_BYTES);

    const accepted = await complete(id, [
      { partNumber: 1, etag: fullFirst },
      { partNumber: 2, etag: lastEtag },
    ]).expect(200);

    expect(accepted.body).toEqual({ id, slug, status: 'processing' });
    const row = await videoRepository.findOneByOrFail({ id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.upload_id).toBeNull();
    await expect(storage.headObject(originalKey(id))).resolves.toEqual({
      size: DECLARED_SIZE,
    });
    await expect(queue.getJob(id)).resolves.toBeDefined();
  });
});
