import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { FfmpegService } from '../media/ffmpeg.service';
import { InvalidMediaError } from '../media/media.errors';
import { MediaModule } from '../media/media.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { createTestVideo } from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { originalKey, thumbnailKey } from '../videos/video-storage-keys';
import { VideoStatus } from '../videos/video.types';
import { VideoProcessingFailure } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// Real Postgres, real `minio` and real ffprobe/ffmpeg (Phase 03 IC-1).
describe('VideoProcessingService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let service: VideoProcessingService;
  let ffmpeg: FfmpegService;
  let videoRepository: Repository<Video>;
  let channelId: string;
  const videoIds: string[] = [];
  const tempFiles: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        MediaModule,
      ],
      providers: [VideoLifecycleService, VideoProcessingService],
    }).compile();

    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    service = module.get(VideoProcessingService);
    ffmpeg = module.get(FfmpegService);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    for (const id of videoIds) {
      await storage.deleteObject(originalKey(id));
      await storage.deleteObject(thumbnailKey(id));
    }
    await Promise.all(tempFiles.map((path) => rm(path, { force: true })));
    await cleanAllTables(dataSource);
    await module.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const user = await users.save(
      users.create({ email: 'processing@example.com', password: 'hashed' }),
    );
    const channel = await channels.save(
      channels.create({
        name: 'processing',
        nickname: 'processing',
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  let slugCounter = 0;
  async function insertVideo(status: VideoStatus): Promise<string> {
    const id = randomUUID();
    videoIds.push(id);
    await videoRepository.insert({
      id,
      channel_id: channelId,
      slug: `proc${String(++slugCounter).padStart(7, '0')}`,
      title: 'clip',
      status,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      upload_id: null,
    });
    return id;
  }

  async function putTestVideo(
    id: string,
    durationSeconds?: number,
  ): Promise<void> {
    const path = await createTestVideo({ durationSeconds });
    tempFiles.push(path);
    await storage.putObject(originalKey(id), await readFile(path), 'video/mp4');
  }

  /** `HEAD` through an internal presigned GET URL; `null` when absent. */
  async function headThumbnail(
    id: string,
  ): Promise<{ contentType: string | null; body: Buffer } | null> {
    if ((await storage.headObject(thumbnailKey(id))) === null) {
      return null;
    }
    const url = await storage.presignGetObject(thumbnailKey(id), {
      client: 'internal',
      expiresIn: 60,
    });
    const res = await fetch(url);
    return {
      contentType: res.headers.get('content-type'),
      body: Buffer.from(await res.arrayBuffer()),
    };
  }

  async function processError(id: string): Promise<unknown> {
    return service.process(id).then(
      () => undefined,
      (err: unknown) => err,
    );
  }

  it('moves a processing video with a valid MP4 to ready with metadata and a JPEG thumbnail', async () => {
    const id = await insertVideo(VideoStatus.PROCESSING);
    await putTestVideo(id);

    await service.process(id);

    const row = await videoRepository.findOneByOrFail({ id });
    expect(row).toEqual(
      expect.objectContaining({
        status: VideoStatus.READY,
        width: 320,
        height: 240,
        video_codec: 'h264',
        thumbnail_key: `videos/${id}/thumbnail.jpg`,
        failure_reason: null,
      }),
    );
    expect(Math.abs(row.duration_ms! - 2000)).toBeLessThanOrEqual(100);

    const thumbnail = await headThumbnail(id);
    expect(thumbnail?.contentType).toBe('image/jpeg');
    expect(thumbnail?.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 60000);

  it('still produces a thumbnail for a 0.4 s video', async () => {
    const id = await insertVideo(VideoStatus.PROCESSING);
    await putTestVideo(id, 0.4);

    await service.process(id);

    const row = await videoRepository.findOneByOrFail({ id });
    expect(row.status).toBe(VideoStatus.READY);
    expect((await headThumbnail(id))?.contentType).toBe('image/jpeg');
  }, 60000);

  it('changes nothing in the row or storage for an already ready video (redelivery)', async () => {
    const id = await insertVideo(VideoStatus.READY);
    await putTestVideo(id);
    const before = await videoRepository.findOneByOrFail({ id });

    await service.process(id);

    await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
      before,
    );
    await expect(storage.headObject(thumbnailKey(id))).resolves.toBeNull();
  }, 60000);

  it('fails with an unrecoverable INVALID_MEDIA error when the original is not a video, leaving the row processing', async () => {
    const id = await insertVideo(VideoStatus.PROCESSING);
    await storage.putObject(originalKey(id), randomBytes(4096), 'video/mp4');

    const error = await processError(id);

    expect(error).toBeInstanceOf(VideoProcessingFailure);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ reason: 'INVALID_MEDIA' });
    await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
      expect.objectContaining({
        status: VideoStatus.PROCESSING,
        failure_reason: null,
      }),
    );
    await expect(storage.headObject(thumbnailKey(id))).resolves.toBeNull();
  }, 60000);

  // Abort racing a winning `complete` (validation note 2): the first HeadObject
  // passes, then the original is deleted before ffprobe/ffmpeg read it.
  it('fails with SOURCE_MISSING (not INVALID_MEDIA) when the original is deleted after the head check, before ffprobe reads it', async () => {
    const id = await insertVideo(VideoStatus.PROCESSING);
    await putTestVideo(id);
    const realProbe = ffmpeg.probe.bind(ffmpeg) as FfmpegService['probe'];
    jest.spyOn(ffmpeg, 'probe').mockImplementationOnce(async (url) => {
      await storage.deleteObject(originalKey(id));
      return realProbe(url);
    });

    const error = await processError(id);

    expect(error).toBeInstanceOf(VideoProcessingFailure);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ reason: 'SOURCE_MISSING' });
    // The real ffprobe did hit the 404 and classified it as invalid media.
    expect((error as VideoProcessingFailure).cause).toBeInstanceOf(
      InvalidMediaError,
    );
    await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
      expect.objectContaining({ status: VideoStatus.PROCESSING }),
    );
    await expect(storage.headObject(thumbnailKey(id))).resolves.toBeNull();
  }, 60000);

  it('fails with SOURCE_MISSING (not THUMBNAIL_FAILED) when the original is deleted after the probe, before the frame is read', async () => {
    const id = await insertVideo(VideoStatus.PROCESSING);
    await putTestVideo(id);
    const realExtractFrame = ffmpeg.extractFrame.bind(
      ffmpeg,
    ) as FfmpegService['extractFrame'];
    const extractFrame = jest
      .spyOn(ffmpeg, 'extractFrame')
      .mockImplementationOnce(async (url, t) => {
        await storage.deleteObject(originalKey(id));
        return realExtractFrame(url, t);
      });

    const error = await processError(id);

    expect(error).toBeInstanceOf(VideoProcessingFailure);
    expect(error).toMatchObject({ reason: 'SOURCE_MISSING' });
    // Both offsets were tried against the real (now missing) object.
    expect(extractFrame).toHaveBeenCalledTimes(2);
    await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
      expect.objectContaining({ status: VideoStatus.PROCESSING }),
    );
    await expect(storage.headObject(thumbnailKey(id))).resolves.toBeNull();
  }, 60000);

  it('fails with an unrecoverable SOURCE_MISSING error when the original does not exist', async () => {
    const id = await insertVideo(VideoStatus.PROCESSING);

    const error = await processError(id);

    expect(error).toBeInstanceOf(VideoProcessingFailure);
    expect(error).toMatchObject({ reason: 'SOURCE_MISSING' });
    await expect(videoRepository.findOneByOrFail({ id })).resolves.toEqual(
      expect.objectContaining({ status: VideoStatus.PROCESSING }),
    );
  }, 30000);
});
