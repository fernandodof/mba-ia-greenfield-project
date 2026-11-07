import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../video.types';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_INVALID_TEXT_REPRESENTATION = '22P02';

const TEN_GIB = 10 * 1024 ** 3;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video-chan-${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      id: randomUUID(),
      channel_id: channelId,
      slug: `slug${String(++counter).padStart(7, '0')}`,
      title: 'My video',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      ...overrides,
    });
  }

  it('should store a video without status as draft with null media and failure columns', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id);

    await videoRepository.insert(video);
    const found = await videoRepository.findOneByOrFail({ id: video.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.failure_reason).toBeNull();
    expect(found.upload_id).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_ms).toBeNull();
    expect(found.width).toBeNull();
    expect(found.height).toBeNull();
    expect(found.video_codec).toBeNull();
    expect(found.processing_started_at).toBeNull();
  });

  it('should auto-populate created_at and updated_at', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id);

    await videoRepository.insert(video);
    const found = await videoRepository.findOneByOrFail({ id: video.id });

    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('should reject two videos with the same slug', async () => {
    const channel = await createChannel();
    await videoRepository.insert(
      buildVideo(channel.id, { slug: 'dupSlug0001' }),
    );

    const duplicate = videoRepository.insert(
      buildVideo(channel.id, { slug: 'dupSlug0001' }),
    );

    await expect(duplicate).rejects.toBeInstanceOf(QueryFailedError);
    await expect(duplicate).rejects.toMatchObject({
      driverError: { code: PG_UNIQUE_VIOLATION },
    });
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();

    const insert = videoRepository.insert(
      buildVideo(channel.id, { status: 'published' as VideoStatus }),
    );

    await expect(insert).rejects.toMatchObject({
      driverError: { code: PG_INVALID_TEXT_REPRESENTATION },
    });
  });

  it('should reject a channel_id that does not exist', async () => {
    const insert = videoRepository.insert(buildVideo(randomUUID()));

    await expect(insert).rejects.toMatchObject({
      driverError: { code: PG_FOREIGN_KEY_VIOLATION },
    });
  });

  it('should read size_bytes of 10 GiB back as a JS number', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id, { size_bytes: TEN_GIB });

    await videoRepository.insert(video);
    const found = await videoRepository.findOneByOrFail({ id: video.id });

    expect(found.size_bytes).toBe(10737418240);
    expect(typeof found.size_bytes).toBe('number');
  });

  it('should round-trip media, failure and processing columns', async () => {
    const channel = await createChannel();
    const processingStartedAt = new Date('2026-11-07T12:34:56.789Z');
    const video = buildVideo(channel.id, {
      status: VideoStatus.FAILED,
      failure_reason: 'INVALID_MEDIA',
      upload_id: 'upload-id-123',
      thumbnail_key: 'videos/x/thumbnail.jpg',
      duration_ms: 61500,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      processing_started_at: processingStartedAt,
    });

    await videoRepository.insert(video);
    const found = await videoRepository.findOneByOrFail({ id: video.id });

    expect(found).toMatchObject({
      status: VideoStatus.FAILED,
      failure_reason: 'INVALID_MEDIA',
      upload_id: 'upload-id-123',
      thumbnail_key: 'videos/x/thumbnail.jpg',
      duration_ms: 61500,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
    });
    expect(found.processing_started_at?.toISOString()).toBe(
      processingStartedAt.toISOString(),
    );
  });

  it('should load the channel and the inverse channel.videos relation', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id);
    await videoRepository.insert(video);

    const foundVideo = await videoRepository.findOneOrFail({
      where: { id: video.id },
      relations: { channel: true },
    });
    const foundChannel = await channelRepository.findOneOrFail({
      where: { id: channel.id },
      relations: { videos: true },
    });

    expect(foundVideo.channel.id).toBe(channel.id);
    expect(foundChannel.videos.map((v) => v.id)).toEqual([video.id]);
  });
});
