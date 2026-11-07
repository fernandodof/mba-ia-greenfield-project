import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { originalKey } from './video-storage-keys';
import { VideoStatus } from './video.types';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

// Real Postgres + the real `minio` Compose service (Phase 03 override IC-1).
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const openSessions: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
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
  }, 30000);

  afterAll(async () => {
    for (const { key, uploadId } of openSessions) {
      await storage.abortMultipartUpload(key, uploadId);
    }
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
});
