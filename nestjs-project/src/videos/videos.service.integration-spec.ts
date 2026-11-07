import { randomBytes, randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { UploadSessionNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './video-queue.constants';
import { originalKey } from './video-storage-keys';
import { generateVideoSlug } from './video-slug.util';
import { VideoStatus } from './video.types';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

// Real Postgres + the real `minio` and `redis` Compose services (Phase 03
// override IC-1); the queue uses the `bull-test` prefix and no worker runs.
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let queue: Queue<VideoProcessingJobData>;
  const openSessions: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, redisConfig],
        }),
        QueueModule,
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  }, 30000);

  afterAll(async () => {
    for (const { key, uploadId } of openSessions) {
      await storage.abortMultipartUpload(key, uploadId);
    }
    for (const row of await videoRepository.find()) {
      await storage.deleteObject(originalKey(row.id));
    }
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    for (const row of await videoRepository.find()) {
      await storage.deleteObject(originalKey(row.id));
    }
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<User> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${n}@example.com`,
        password: 'hashed',
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: `videos${n}`,
        nickname: `videos_svc_${n}`,
        user_id: user.id,
      }),
    );
    return user;
  }

  async function startUpload(userId: string) {
    const session = await service.startUpload(userId, {
      filename: 'clip.mp4',
      size: 1048576,
      contentType: 'video/mp4',
    });
    const row = await videoRepository.findOneByOrFail({ id: session.id });
    openSessions.push({ key: originalKey(row.id), uploadId: row.upload_id! });
    return { session, row };
  }

  describe('startUpload', () => {
    it("persists a draft with its upload_id in the caller's channel", async () => {
      const user = await createUserWithChannel();
      const channel = await channelRepository.findOneByOrFail({
        user_id: user.id,
      });

      const { session, row } = await startUpload(user.id);

      expect(session.status).toBe(VideoStatus.DRAFT);
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.slug).toBe(session.slug);
      expect(row.channel_id).toBe(channel.id);
      expect(row.title).toBe('clip');
      expect(row.size_bytes).toBe(1048576);
      expect(row.upload_id).toEqual(expect.any(String));
    });

    it('opens a multipart upload in storage with no parts yet', async () => {
      const user = await createUserWithChannel();

      const { row } = await startUpload(user.id);

      await expect(
        storage.listParts(originalKey(row.id), row.upload_id!),
      ).resolves.toEqual([]);
    });
  });

  describe('findOwnedById', () => {
    it('returns the video to its owner', async () => {
      const user = await createUserWithChannel();
      const { session } = await startUpload(user.id);

      const video = await service.findOwnedById(user.id, session.id);

      expect(video.id).toBe(session.id);
    });

    it("throws VIDEO_NOT_FOUND for another user's video", async () => {
      const owner = await createUserWithChannel();
      const other = await createUserWithChannel();
      const { session } = await startUpload(owner.id);

      await expect(
        service.findOwnedById(other.id, session.id),
      ).rejects.toMatchObject({
        errorCode: 'VIDEO_NOT_FOUND',
        httpStatus: 404,
      });
    });

    it('throws VIDEO_NOT_FOUND for an unknown id', async () => {
      const user = await createUserWithChannel();

      await expect(
        service.findOwnedById(user.id, randomUUID()),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_FOUND' });
    });
  });

  describe('signUploadParts / listUploadedParts', () => {
    it('signs a part URL that accepts a plain PUT, then lists that part for resume', async () => {
      const user = await createUserWithChannel();
      const { session } = await startUpload(user.id);
      const bytes = randomBytes(1024);

      const signed = await service.signUploadParts(user.id, session.id, [1]);
      const put = await fetch(signed.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
      });

      expect(put.status).toBe(200);
      const etag = put.headers.get('etag');
      expect(etag).toBeTruthy();
      await expect(
        service.listUploadedParts(user.id, session.id),
      ).resolves.toEqual({ parts: [{ partNumber: 1, etag, size: 1024 }] });
    });

    it('throws VIDEO_UPLOAD_NOT_ACTIVE after the upload was aborted directly in storage, leaving the row a draft', async () => {
      const user = await createUserWithChannel();
      const { session, row } = await startUpload(user.id);
      await storage.abortMultipartUpload(originalKey(row.id), row.upload_id!);

      await expect(
        service.listUploadedParts(user.id, session.id),
      ).rejects.toMatchObject({
        errorCode: 'VIDEO_UPLOAD_NOT_ACTIVE',
        httpStatus: 409,
      });
      await expect(
        videoRepository.findOneByOrFail({ id: session.id }),
      ).resolves.toMatchObject({ status: VideoStatus.DRAFT });
    });
  });

  describe('abortUpload', () => {
    it('releases the multipart upload and the original, and marks the row failed/UPLOAD_ABORTED', async () => {
      const user = await createUserWithChannel();
      const { session, row } = await startUpload(user.id);
      const key = originalKey(row.id);
      const signed = await service.signUploadParts(user.id, session.id, [1]);
      const put = await fetch(signed.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(1024)),
      });
      expect(put.status).toBe(200);
      // Crash window: an original already stored for this draft.
      await storage.putObject(key, randomBytes(16), 'video/mp4');

      await service.abortUpload(user.id, session.id);

      await expect(
        storage.listParts(key, row.upload_id!),
      ).rejects.toBeInstanceOf(UploadSessionNotFoundError);
      await expect(storage.headObject(key)).resolves.toBeNull();
      await expect(
        videoRepository.findOneByOrFail({ id: session.id }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: VideoStatus.FAILED,
          failure_reason: 'UPLOAD_ABORTED',
          upload_id: null,
        }),
      );
    });

    it('still fails the draft when the storage upload is already gone', async () => {
      const user = await createUserWithChannel();
      const { session, row } = await startUpload(user.id);
      await storage.abortMultipartUpload(originalKey(row.id), row.upload_id!);

      await service.abortUpload(user.id, session.id);

      await expect(
        videoRepository.findOneByOrFail({ id: session.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.FAILED,
        failure_reason: 'UPLOAD_ABORTED',
      });
    });
  });

  describe('completeUpload', () => {
    // Uploads `bytes` as part 1 of a draft declared with `declaredSize`.
    async function uploadDraft(
      userId: string,
      bytes: Buffer,
      declaredSize = bytes.length,
    ) {
      const session = await service.startUpload(userId, {
        filename: 'clip.mp4',
        size: declaredSize,
        contentType: 'video/mp4',
      });
      const row = await videoRepository.findOneByOrFail({ id: session.id });
      openSessions.push({ key: originalKey(row.id), uploadId: row.upload_id! });
      const signed = await service.signUploadParts(userId, session.id, [1]);
      const put = await fetch(signed.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
      });
      expect(put.status).toBe(200);
      const etag = put.headers.get('etag')!;
      return { session, row, parts: [{ partNumber: 1, etag }] };
    }

    it('moves the row to processing and enqueues one job with attempts: 3', async () => {
      const user = await createUserWithChannel();
      const { session, parts } = await uploadDraft(user.id, randomBytes(2048));

      await expect(
        service.completeUpload(user.id, session.id, parts),
      ).resolves.toEqual({
        id: session.id,
        slug: session.slug,
        status: VideoStatus.PROCESSING,
      });

      const row = await videoRepository.findOneByOrFail({ id: session.id });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.upload_id).toBeNull();
      expect(row.processing_started_at).toBeInstanceOf(Date);
      await expect(
        storage.headObject(originalKey(session.id)),
      ).resolves.toEqual({ size: 2048 });
      const job = await queue.getJob(session.id);
      expect(job?.data).toEqual({ videoId: session.id });
      expect(job?.opts.attempts).toBe(3);
    });

    it('is idempotent: a second call returns the same body and keeps one job', async () => {
      const user = await createUserWithChannel();
      const { session, parts } = await uploadDraft(user.id, randomBytes(2048));
      const first = await service.completeUpload(user.id, session.id, parts);
      const startedAt = (
        await videoRepository.findOneByOrFail({ id: session.id })
      ).processing_started_at;

      await expect(
        service.completeUpload(user.id, session.id, parts),
      ).resolves.toEqual(first);

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.map((job) => job.id)).toEqual([session.id]);
      await expect(
        videoRepository.findOneByOrFail({ id: session.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        processing_started_at: startedAt,
      });
    });

    it('recovers when storage already completed the upload but the row is still a draft', async () => {
      const user = await createUserWithChannel();
      const { session, row, parts } = await uploadDraft(
        user.id,
        randomBytes(2048),
      );
      await storage.completeMultipartUpload(
        originalKey(row.id),
        row.upload_id!,
        parts,
      );

      await expect(
        service.completeUpload(user.id, session.id, parts),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });

      await expect(
        videoRepository.findOneByOrFail({ id: session.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      await expect(queue.getJob(session.id)).resolves.toBeDefined();
    });

    it('deletes the object and fails the draft as UPLOAD_SIZE_MISMATCH when the size differs', async () => {
      const user = await createUserWithChannel();
      const { session, parts } = await uploadDraft(
        user.id,
        randomBytes(1024),
        2048,
      );

      await expect(
        service.completeUpload(user.id, session.id, parts),
      ).rejects.toMatchObject({
        errorCode: 'UPLOAD_SIZE_MISMATCH',
        httpStatus: 422,
      });

      await expect(
        storage.headObject(originalKey(session.id)),
      ).resolves.toBeNull();
      await expect(
        videoRepository.findOneByOrFail({ id: session.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.FAILED,
        failure_reason: 'UPLOAD_SIZE_MISMATCH',
        upload_id: null,
      });
      await expect(queue.getJob(session.id)).resolves.toBeUndefined();
    });
  });

  describe('getPlaybackUrl', () => {
    const OBJECT_SIZE = 2048;

    // Seeds the row directly (no upload/worker flow needed) and, for `ready`
    // rows, puts the original object straight into storage.
    async function seedVideo(
      status: VideoStatus,
      overrides: Partial<Video> = {},
    ): Promise<{ video: Video; bytes: Buffer }> {
      const user = await createUserWithChannel();
      const channel = await channelRepository.findOneByOrFail({
        user_id: user.id,
      });
      const bytes = randomBytes(OBJECT_SIZE);
      const video = await videoRepository.save(
        videoRepository.create({
          id: randomUUID(),
          slug: generateVideoSlug(),
          channel_id: channel.id,
          title: 'My clip',
          original_filename: 'clip.mp4',
          content_type: 'video/mp4',
          size_bytes: OBJECT_SIZE,
          status,
          ...overrides,
        }),
      );
      if (status === VideoStatus.READY) {
        await storage.putObject(
          originalKey(video.id),
          bytes,
          video.content_type,
        );
      }
      return { video, bytes };
    }

    it('returns a stream URL that storage answers with 206 for a Range request', async () => {
      const { video, bytes } = await seedVideo(VideoStatus.READY, {
        content_type: 'video/webm',
      });

      const url = await service.getPlaybackUrl(video.slug, 'stream');
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-type')).toBe('video/webm');
      expect(response.headers.get('content-disposition')).toBeNull();
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(bytes.subarray(0, 1024))).toBe(true);
    });

    it('returns a download URL that storage answers with the attachment disposition', async () => {
      const { video } = await seedVideo(VideoStatus.READY, {
        title: 'Férias: dia 1/2',
        original_filename: 'clip.MP4',
      });

      const url = await service.getPlaybackUrl(video.slug, 'download');
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="F_rias dia 12.mp4"; filename*=UTF-8\'\'F%C3%A9rias%20dia%2012.mp4',
      );
      await response.arrayBuffer();
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'throws VIDEO_NOT_FOUND for a %s video',
      async (status) => {
        const { video } = await seedVideo(status);

        await expect(
          service.getPlaybackUrl(video.slug, 'stream'),
        ).rejects.toMatchObject({
          errorCode: 'VIDEO_NOT_FOUND',
          httpStatus: 404,
        });
      },
    );

    it('throws VIDEO_NOT_FOUND for an unknown slug', async () => {
      await expect(
        service.getPlaybackUrl(generateVideoSlug(), 'download'),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_FOUND' });
    });
  });
});
