import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { UploadSessionNotFoundError } from '../storage/storage.errors';
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
});
