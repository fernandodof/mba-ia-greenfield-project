import { randomBytes, randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { UnrecoverableError, Worker, type Queue } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import redisConfig from '../config/redis.config';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { UploadSessionNotFoundError } from '../storage/storage.errors';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../videos/video-queue.constants';
import { originalKey } from '../videos/video-storage-keys';
import { VideoStatus } from '../videos/video.types';
import { VideoSweeperService } from './video-sweeper.service';
import { VideoWorkerModule } from './video-worker.module';

// Thresholds independent of the env values; rows are aged past them by SQL.
const STUCK_AFTER_MS = 5 * 60_000;
const EXPIRE_AFTER_MS = 10 * 60_000;
const AGED_BY_MS = 60 * 60_000;

// Real Postgres, Redis (`bull-test`) and `minio` (Phase 03 IC-1). The module
// is compiled but not initialised, so no BullMQ worker consumes the jobs and
// the scheduler does not run: the test drives `sweep()` itself.
describe('VideoSweeperService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let sweeper: VideoSweeperService;
  let queue: Queue<VideoProcessingJobData>;
  let videoRepository: Repository<Video>;
  let redis: ConfigType<typeof redisConfig>;
  let channelId: string;
  const videoIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    })
      .overrideProvider(videoConfig.KEY)
      .useValue({
        workerConcurrency: 1,
        sweeperIntervalMs: 900000,
        processingStuckAfterMs: STUCK_AFTER_MS,
        uploadExpireAfterMs: EXPIRE_AFTER_MS,
      })
      .compile();
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    sweeper = module.get(VideoSweeperService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    redis = module.get(redisConfig.KEY);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    try {
      await queue.obliterate({ force: true });
      for (const id of videoIds) {
        await storage.deleteObject(originalKey(id));
      }
      await cleanAllTables(dataSource);
    } finally {
      await module.close();
    }
  }, 30000);

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const user = await users.save(
      users.create({ email: 'sweeper@example.com', password: 'hashed' }),
    );
    const channel = await channels.save(
      channels.create({
        name: 'sweeper',
        nickname: 'sweeper',
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  let slugCounter = 0;
  async function insertVideo(
    status: VideoStatus,
    uploadId: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    videoIds.push(id);
    await videoRepository.insert({
      id,
      channel_id: channelId,
      slug: `swp${String(++slugCounter).padStart(8, '0')}`,
      title: 'clip',
      status,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      upload_id: uploadId,
      processing_started_at:
        status === VideoStatus.PROCESSING ? () => 'now()' : null,
    });
    return id;
  }

  async function backdate(
    id: string,
    column: 'created_at' | 'processing_started_at',
  ): Promise<void> {
    await dataSource.query(
      `UPDATE "videos" SET "${column}" = "${column}" - $2 * interval '1 millisecond' WHERE "id" = $1`,
      [id, AGED_BY_MS],
    );
  }

  /** Leaves a retained `failed` job for `videoId`, fetched and failed by hand. */
  async function addFailedJob(videoId: string): Promise<void> {
    await queue.add(VIDEO_PROCESS_JOB, { videoId }, { jobId: videoId });
    const worker = new Worker(VIDEO_PROCESSING_QUEUE, null, {
      connection: { host: redis.host, port: redis.port },
      prefix: redis.queuePrefix,
      autorun: false,
    });
    try {
      const token = randomUUID();
      const job = await worker.getNextJob(token);
      expect(job?.id).toBe(videoId);
      await job.moveToFailed(new UnrecoverableError('boom'), token);
    } finally {
      await worker.close();
    }
    await expect(
      queue.getJob(videoId).then((j) => j?.getState()),
    ).resolves.toBe('failed');
  }

  it('re-adds the process job (jobId = videoId) for a stuck processing video without a job', async () => {
    const id = await insertVideo(VideoStatus.PROCESSING);
    await backdate(id, 'processing_started_at');

    await sweeper.sweep();

    const job = await queue.getJob(id);
    expect(job).toBeDefined();
    expect(job!.name).toBe(VIDEO_PROCESS_JOB);
    expect(job!.data).toEqual({ videoId: id });
    await expect(job!.getState()).resolves.toBe('waiting');
    await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
      expect.objectContaining({ status: VideoStatus.PROCESSING }),
    );
  });

  it('marks a stuck video with a retained failed job failed/PROCESSING_FAILED and does not re-add it', async () => {
    const id = await insertVideo(VideoStatus.PROCESSING);
    await addFailedJob(id);
    await backdate(id, 'processing_started_at');

    await sweeper.sweep();

    await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
      expect.objectContaining({
        status: VideoStatus.FAILED,
        failure_reason: 'PROCESSING_FAILED',
      }),
    );
    const job = await queue.getJob(id);
    await expect(job!.getState()).resolves.toBe('failed');
    expect(job!.attemptsMade).toBe(1);
    await expect(queue.getWaitingCount()).resolves.toBe(0);
  });

  it('leaves a stuck video whose job is still waiting unchanged', async () => {
    const id = await insertVideo(VideoStatus.PROCESSING);
    await queue.add(VIDEO_PROCESS_JOB, { videoId: id }, { jobId: id });
    await backdate(id, 'processing_started_at');

    await sweeper.sweep();

    await expect(queue.getJobCounts('waiting')).resolves.toEqual({
      waiting: 1,
    });
    await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
      expect.objectContaining({ status: VideoStatus.PROCESSING }),
    );
  });

  it('expires a draft with a live multipart upload: upload aborted, original absent, failed/UPLOAD_EXPIRED', async () => {
    const id = randomUUID();
    const key = originalKey(id);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    // The original can also exist after the AMB-7 crash window.
    await storage.putObject(key, randomBytes(1024), 'video/mp4');
    videoIds.push(id);
    await videoRepository.insert({
      id,
      channel_id: channelId,
      slug: `swp${String(++slugCounter).padStart(8, '0')}`,
      title: 'clip',
      status: VideoStatus.DRAFT,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      upload_id: uploadId,
    });
    await backdate(id, 'created_at');

    await sweeper.sweep();

    await expect(storage.listParts(key, uploadId)).rejects.toBeInstanceOf(
      UploadSessionNotFoundError,
    );
    await expect(storage.headObject(key)).resolves.toBeNull();
    await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
      expect.objectContaining({
        status: VideoStatus.FAILED,
        failure_reason: 'UPLOAD_EXPIRED',
        upload_id: null,
      }),
    );
  });

  it('leaves a fresh draft and a fresh processing video untouched', async () => {
    const key = originalKey(randomUUID());
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const draft = await insertVideo(VideoStatus.DRAFT, uploadId);
    const processing = await insertVideo(VideoStatus.PROCESSING);

    try {
      await sweeper.sweep();

      await expect(
        videoRepository.findOneByOrFail({ id: draft }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: VideoStatus.DRAFT,
          failure_reason: null,
          upload_id: uploadId,
        }),
      );
      await expect(
        videoRepository.findOneByOrFail({ id: processing }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: VideoStatus.PROCESSING,
          failure_reason: null,
        }),
      );
      await expect(storage.listParts(key, uploadId)).resolves.toEqual([]);
      await expect(queue.getJob(processing)).resolves.toBeUndefined();
    } finally {
      await storage.abortMultipartUpload(key, uploadId);
    }
  });
});
