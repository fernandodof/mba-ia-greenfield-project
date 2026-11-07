import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError, type Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import type { MockedMethods } from '../test/mocked-methods';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VIDEO_PART_SIZE_BYTES } from './video.constants';
import { VideoStatus } from './video.types';
import { VideoNotFoundException } from './videos.exceptions';
import { VideosService } from './videos.service';

const USER_ID = '6f1d7f4e-2f7a-4d0e-9f2b-1d2c3b4a5f60';
const CHANNEL_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const UPLOAD_ID = 'upload-123';

type VideoRepositoryMock = Pick<
  MockedMethods<Repository<Video>>,
  'insert' | 'findOne'
>;
type ChannelsServiceMock = Pick<MockedMethods<ChannelsService>, 'findByUserId'>;
type StorageServiceMock = Pick<
  MockedMethods<StorageService>,
  'createMultipartUpload' | 'abortMultipartUpload'
>;

function makeChannel(): Channel {
  const channel = new Channel();
  channel.id = CHANNEL_ID;
  channel.user_id = USER_ID;
  return channel;
}

function makeUniqueError(column: string): QueryFailedError {
  return Object.assign(new QueryFailedError('INSERT', [], new Error()), {
    code: '23505',
    detail: `Key (${column})=(abc) already exists.`,
  });
}

function makeDto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
  return {
    filename: 'clip.mp4',
    size: 1048576,
    contentType: 'video/mp4',
    ...overrides,
  };
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: Pick<
    MockedMethods<Repository<Video>>,
    'insert' | 'findOne'
  >;
  let channelsService: Pick<MockedMethods<ChannelsService>, 'findByUserId'>;
  let storage: Pick<
    MockedMethods<StorageService>,
    'createMultipartUpload' | 'abortMultipartUpload'
  >;

  beforeEach(async () => {
    videoRepository = {
      insert: jest.fn() as VideoRepositoryMock['insert'],
      findOne: jest.fn() as VideoRepositoryMock['findOne'],
    };
    channelsService = {
      findByUserId: jest.fn() as ChannelsServiceMock['findByUserId'],
    };
    channelsService.findByUserId.mockResolvedValue(makeChannel());
    storage = {
      createMultipartUpload:
        jest.fn() as StorageServiceMock['createMultipartUpload'],
      abortMultipartUpload:
        jest.fn() as StorageServiceMock['abortMultipartUpload'],
    };
    storage.createMultipartUpload.mockResolvedValue(UPLOAD_ID);
    storage.abortMultipartUpload.mockResolvedValue(undefined);

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('startUpload', () => {
    it('should insert a draft with the default title and open the session for its key', async () => {
      videoRepository.insert.mockResolvedValue({} as never);

      const result = await service.startUpload(USER_ID, makeDto());

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.partSize).toBe(VIDEO_PART_SIZE_BYTES);
      expect(result.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.id}/original`,
        'video/mp4',
      );
      expect(videoRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.id,
          slug: result.slug,
          channel_id: CHANNEL_ID,
          title: 'clip',
          original_filename: 'clip.mp4',
          content_type: 'video/mp4',
          size_bytes: 1048576,
          upload_id: UPLOAD_ID,
          status: VideoStatus.DRAFT,
        }),
      );
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should keep an explicit title', async () => {
      videoRepository.insert.mockResolvedValue({} as never);

      await service.startUpload(USER_ID, makeDto({ title: 'My video' }));

      expect(videoRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'My video' }),
      );
    });

    it.each([
      [1, 1],
      [VIDEO_PART_SIZE_BYTES, 1],
      [VIDEO_PART_SIZE_BYTES + 1, 2],
    ])('should compute partCount for size %i as %i', async (size, expected) => {
      videoRepository.insert.mockResolvedValue({} as never);

      const result = await service.startUpload(USER_ID, makeDto({ size }));

      expect(result.partCount).toBe(expected);
    });

    it('should retry with a new slug after a slug collision and then succeed', async () => {
      videoRepository.insert
        .mockRejectedValueOnce(makeUniqueError('slug'))
        .mockResolvedValueOnce({} as never);

      const result = await service.startUpload(USER_ID, makeDto());

      expect(videoRepository.insert).toHaveBeenCalledTimes(2);
      const [first] = videoRepository.insert.mock.calls[0] as [Partial<Video>];
      const [second] = videoRepository.insert.mock.calls[1] as [Partial<Video>];
      expect(second.slug).not.toBe(first.slug);
      expect(result.slug).toBe(second.slug);
      expect(second.id).toBe(first.id);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should abort the multipart upload and rethrow after 3 slug collisions', async () => {
      const collision = makeUniqueError('slug');
      videoRepository.insert.mockRejectedValue(collision);

      await expect(service.startUpload(USER_ID, makeDto())).rejects.toBe(
        collision,
      );

      expect(videoRepository.insert).toHaveBeenCalledTimes(3);
      const [draft] = videoRepository.insert.mock.calls[0] as [Partial<Video>];
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        `videos/${draft.id}/original`,
        UPLOAD_ID,
      );
    });

    it('should not retry a unique violation on another column', async () => {
      const violation = makeUniqueError('id');
      videoRepository.insert.mockRejectedValue(violation);

      await expect(service.startUpload(USER_ID, makeDto())).rejects.toBe(
        violation,
      );

      expect(videoRepository.insert).toHaveBeenCalledTimes(1);
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should throw a plain error without touching storage when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.startUpload(USER_ID, makeDto())).rejects.toThrow(
        Error,
      );

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.insert).not.toHaveBeenCalled();
    });
  });

  describe('findOwnedById', () => {
    it('should scope the lookup to the caller and return the video', async () => {
      const video = new Video();
      video.id = 'video-id';
      videoRepository.findOne.mockResolvedValue(video);

      await expect(service.findOwnedById(USER_ID, 'video-id')).resolves.toBe(
        video,
      );
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'video-id', channel: { user_id: USER_ID } },
      });
    });

    it('should throw VideoNotFoundException when no owned video matches', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOwnedById(USER_ID, 'video-id'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
