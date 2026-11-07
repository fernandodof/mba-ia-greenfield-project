import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoLifecycleService } from './video-lifecycle.service';
import { VideoStatus } from './video.types';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoLifecycleService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let lifecycle: VideoLifecycleService;
  let videoRepository: Repository<Video>;
  let channelId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [VideoLifecycleService],
    }).compile();

    dataSource = module.get(DataSource);
    lifecycle = module.get(VideoLifecycleService);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const user = await users.save(
      users.create({ email: 'lifecycle@example.com', password: 'hashed' }),
    );
    const channel = await channels.save(
      channels.create({
        name: 'lifecycle',
        nickname: 'lifecycle',
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  let slugCounter = 0;
  async function insertVideo(
    status: VideoStatus,
    uploadId: string | null,
  ): Promise<string> {
    const id = randomUUID();
    await videoRepository.insert({
      id,
      channel_id: channelId,
      slug: `lifecycle${String(++slugCounter).padStart(2, '0')}`,
      title: 'clip',
      status,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1048576,
      upload_id: uploadId,
    });
    return id;
  }

  describe('failDraft', () => {
    it('moves a draft to failed with the reason and clears upload_id', async () => {
      const id = await insertVideo(VideoStatus.DRAFT, 'upload-1');

      await expect(lifecycle.failDraft(id, 'UPLOAD_ABORTED')).resolves.toBe(
        true,
      );

      await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
        expect.objectContaining({
          status: VideoStatus.FAILED,
          failure_reason: 'UPLOAD_ABORTED',
          upload_id: null,
        }),
      );
    });

    it('updates only the targeted draft', async () => {
      const target = await insertVideo(VideoStatus.DRAFT, 'upload-1');
      const other = await insertVideo(VideoStatus.DRAFT, 'upload-2');

      await lifecycle.failDraft(target, 'UPLOAD_EXPIRED');

      await expect(
        videoRepository.findOneByOrFail({ id: other }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: VideoStatus.DRAFT,
          failure_reason: null,
          upload_id: 'upload-2',
        }),
      );
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'returns false and leaves a %s video unchanged',
      async (status) => {
        const id = await insertVideo(status, null);

        await expect(lifecycle.failDraft(id, 'UPLOAD_ABORTED')).resolves.toBe(
          false,
        );

        await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
          expect.objectContaining({ status, failure_reason: null }),
        );
      },
    );

    it('returns false for an unknown id', async () => {
      await expect(
        lifecycle.failDraft(randomUUID(), 'UPLOAD_ABORTED'),
      ).resolves.toBe(false);
    });
  });

  describe('markProcessing', () => {
    it('moves a draft to processing, clears upload_id and stamps processing_started_at', async () => {
      const id = await insertVideo(VideoStatus.DRAFT, 'upload-1');
      const before = new Date();

      await expect(lifecycle.markProcessing(id)).resolves.toBe(true);

      const row = await videoRepository.findOneByOrFail({ id });
      expect(row).toEqual(
        expect.objectContaining({
          status: VideoStatus.PROCESSING,
          upload_id: null,
          failure_reason: null,
        }),
      );
      expect(row.processing_started_at).toBeInstanceOf(Date);
      // DB clock vs. test clock: allow a little skew.
      expect(row.processing_started_at!.getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 5000,
      );
    });

    it('updates only the targeted draft', async () => {
      const target = await insertVideo(VideoStatus.DRAFT, 'upload-1');
      const other = await insertVideo(VideoStatus.DRAFT, 'upload-2');

      await lifecycle.markProcessing(target);

      await expect(
        videoRepository.findOneByOrFail({ id: other }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: VideoStatus.DRAFT,
          upload_id: 'upload-2',
          processing_started_at: null,
        }),
      );
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'returns false and leaves a %s video unchanged',
      async (status) => {
        const id = await insertVideo(status, null);

        await expect(lifecycle.markProcessing(id)).resolves.toBe(false);

        await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
          expect.objectContaining({ status, processing_started_at: null }),
        );
      },
    );

    it('returns false for an unknown id', async () => {
      await expect(lifecycle.markProcessing(randomUUID())).resolves.toBe(false);
    });
  });
});
