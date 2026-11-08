import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { generateVideoSlug } from '../src/videos/video-slug.util';
import { originalKey } from '../src/videos/video-storage-keys';
import {
  VideoStatus,
  type VideoFailureReason,
} from '../src/videos/video.types';
import {
  createAuthenticatedUser,
  type AuthenticatedUser,
} from './helpers/authenticated-user';

// Spec: specs/videos-playback.plan.md (SI-03.10). Real Postgres and minio via
// Compose service names; the Jest setup file sets S3_PUBLIC_ENDPOINT =
// S3_ENDPOINT, so the redirect Location can be fetched from this process.

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

interface SeedOptions {
  status: VideoStatus;
  title?: string;
  originalFilename?: string;
  contentType?: string;
  failureReason?: VideoFailureReason | null;
}

const OBJECT_SIZE = 2048;
const UNKNOWN_SLUG = 'AAAAAAAAAAA';

const VIDEO_NOT_FOUND = {
  statusCode: 404,
  error: 'VIDEO_NOT_FOUND',
  message: 'Video not found',
};

const NON_READY: SeedOptions[] = [
  { status: VideoStatus.DRAFT },
  { status: VideoStatus.PROCESSING },
  { status: VideoStatus.FAILED, failureReason: 'INVALID_MEDIA' },
];

describe('videos-playback', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userA: AuthenticatedUser;

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
    channelRepository = dataSource.getRepository(Channel);
  });

  afterAll(async () => {
    await deleteSeededObjects();
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await deleteSeededObjects();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    userA = await createAuthenticatedUser(app, dataSource, 'owner@example.com');
  });

  async function deleteSeededObjects(): Promise<void> {
    for (const row of await videoRepository.find()) {
      await storage.deleteObject(originalKey(row.id));
    }
  }

  // Inserts the row directly (no upload/worker flow; SI-03.10 depends only on
  // SI-03.6) and, for `ready` rows, puts the original object into storage.
  async function seedVideo(
    options: SeedOptions,
  ): Promise<{ video: Video; bytes: Buffer }> {
    const channel = await channelRepository.findOneByOrFail({
      user_id: userA.userId,
    });
    const bytes = randomBytes(OBJECT_SIZE);
    const video = await videoRepository.save(
      videoRepository.create({
        id: randomUUID(),
        slug: generateVideoSlug(),
        channel_id: channel.id,
        title: options.title ?? 'My clip',
        original_filename: options.originalFilename ?? 'clip.mp4',
        content_type: options.contentType ?? 'video/mp4',
        size_bytes: OBJECT_SIZE,
        status: options.status,
        failure_reason: options.failureReason ?? null,
      }),
    );
    if (options.status === VideoStatus.READY) {
      await storage.putObject(originalKey(video.id), bytes, video.content_type);
    }
    return { video, bytes };
  }

  function play(
    slug: string,
    mode: 'stream' | 'download',
    accessToken?: string,
  ): request.Test {
    const req = request(app.getHttpServer()).get(`/videos/${slug}/${mode}`);
    return accessToken
      ? req.set('Authorization', `Bearer ${accessToken}`)
      : req;
  }

  function expectPresignedLocation(location: string, videoId: string): URL {
    const url = new URL(location);
    expect(url.host).toBe(new URL(process.env.S3_PUBLIC_ENDPOINT!).host);
    expect(url.pathname.endsWith(`/${originalKey(videoId)}`)).toBe(true);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    return url;
  }

  async function downloadDisposition(slug: string): Promise<string | null> {
    const res = await play(slug, 'download').expect(302);
    const response = await fetch(res.headers.location, { redirect: 'manual' });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    return response.headers.get('content-disposition');
  }

  // 1. GET /videos/:slug/stream

  it('stream-redirects-anonymous-caller-to-presigned-url', async () => {
    const { video } = await seedVideo({
      status: VideoStatus.READY,
      contentType: 'video/mp4',
    });

    const anonymous = await play(video.slug, 'stream').expect(302);

    expect(anonymous.headers['cache-control']).toBe('no-store');
    const url = expectPresignedLocation(anonymous.headers.location, video.id);
    expect(url.searchParams.has('response-content-disposition')).toBe(false);
    expect(url.searchParams.has('response-content-type')).toBe(false);

    await play(video.slug, 'stream', userA.accessToken).expect(302);
  });

  it('stream-location-serves-range-with-206', async () => {
    const { video, bytes } = await seedVideo({
      status: VideoStatus.READY,
      contentType: 'video/mp4',
    });
    const res = await play(video.slug, 'stream').expect(302);

    const response = await fetch(res.headers.location, {
      redirect: 'manual',
      headers: { Range: 'bytes=0-1023' },
    });

    expect(response.status).toBe(206);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body).toHaveLength(1024);
    expect(body.equals(bytes.subarray(0, 1024))).toBe(true);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-1023/${OBJECT_SIZE}`,
    );
  });

  it('stream-404-for-unknown-or-non-ready-video', async () => {
    const unknown = await play(UNKNOWN_SLUG, 'stream').expect(404);
    expect(unknown.body as ErrorResponseBody).toEqual(VIDEO_NOT_FOUND);
    expect(unknown.headers.location).toBeUndefined();

    const seeded: Video[] = [];
    for (const options of NON_READY) {
      const { video } = await seedVideo(options);
      seeded.push(video);
      const res = await play(video.slug, 'stream').expect(404);
      expect(res.body as ErrorResponseBody).toEqual(VIDEO_NOT_FOUND);
      expect(res.headers.location).toBeUndefined();
    }

    const draft = seeded[0];
    const asOwner = await play(draft.slug, 'stream', userA.accessToken).expect(
      404,
    );
    expect((asOwner.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
  });

  // 2. GET /videos/:slug/download

  it('download-redirects-with-content-disposition', async () => {
    const { video } = await seedVideo({
      status: VideoStatus.READY,
      title: 'Férias: dia 1/2',
      originalFilename: 'clip.MP4',
      contentType: 'video/mp4',
    });

    const res = await play(video.slug, 'download').expect(302);

    expect(res.headers['cache-control']).toBe('no-store');
    expectPresignedLocation(res.headers.location, video.id);
    const response = await fetch(res.headers.location, { redirect: 'manual' });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="F_rias dia 12.mp4"; filename*=UTF-8''F%C3%A9rias%20dia%2012.mp4`,
    );
  });

  it('download-omits-invalid-extension', async () => {
    const expected = `attachment; filename="My clip"; filename*=UTF-8''My%20clip`;

    const { video: noExt } = await seedVideo({
      status: VideoStatus.READY,
      title: 'My clip',
      originalFilename: 'noext',
    });
    await expect(downloadDisposition(noExt.slug)).resolves.toBe(expected);

    const { video: longExt } = await seedVideo({
      status: VideoStatus.READY,
      title: 'My clip',
      originalFilename: 'a.verylongext1',
    });
    await expect(downloadDisposition(longExt.slug)).resolves.toBe(expected);
  });

  // Post-QA fix: U+202E (RLO) would display `clip‮gpj.exe.mp4` as `clip…4pm.exe.jpg`.
  it('download-strips-bidi-override-from-content-disposition', async () => {
    const { video } = await seedVideo({
      status: VideoStatus.READY,
      title: 'clip‮gpj.exe',
      originalFilename: 'clip.mp4',
    });

    const res = await play(video.slug, 'download').expect(302);
    const location = new URL(res.headers.location);
    expect(
      location.searchParams.get('response-content-disposition'),
    ).not.toContain('‮');

    const disposition = await downloadDisposition(video.slug);
    expect(disposition).toBe(
      `attachment; filename="clipgpj.exe.mp4"; filename*=UTF-8''clipgpj.exe.mp4`,
    );
    expect(disposition).not.toMatch(/%E2%80%AE|‮/i);
  });

  it('download-404-for-unknown-or-non-ready-video', async () => {
    const unknown = await play(UNKNOWN_SLUG, 'download').expect(404);
    expect(unknown.body as ErrorResponseBody).toEqual(VIDEO_NOT_FOUND);
    expect(unknown.headers.location).toBeUndefined();

    for (const options of NON_READY) {
      const { video } = await seedVideo(options);
      const res = await play(video.slug, 'download').expect(404);
      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
      expect(res.headers.location).toBeUndefined();
    }
  });
});
