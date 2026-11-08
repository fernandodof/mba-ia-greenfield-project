import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError, type Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidUploadPartsError,
  UploadSessionNotFoundError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { MockedMethods } from '../test/mocked-methods';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import {
  PLAYBACK_URL_TTL_SECONDS,
  UPLOAD_PART_URL_TTL_SECONDS,
  VIDEO_PART_SIZE_BYTES,
} from './video.constants';
import { VideoLifecycleService } from './video-lifecycle.service';
import { VideoProcessingQueue } from './video-processing.queue';
import { VideoStatus } from './video.types';
import {
  UploadPartsInvalidException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoUploadNotActiveException,
} from './videos.exceptions';
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
  | 'createMultipartUpload'
  | 'abortMultipartUpload'
  | 'presignUploadPart'
  | 'listParts'
  | 'deleteObject'
  | 'completeMultipartUpload'
  | 'headObject'
  | 'presignGetObject'
>;
type LifecycleServiceMock = Pick<
  MockedMethods<VideoLifecycleService>,
  'failDraft' | 'markProcessing'
>;
type ProcessingQueueMock = Pick<MockedMethods<VideoProcessingQueue>, 'enqueue'>;

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

const VIDEO_ID = '0b9f3c1e-6d2a-4f8b-9c7e-5a4d3b2c1f00';
const VIDEO_KEY = `videos/${VIDEO_ID}/original`;

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: VIDEO_ID,
    status: VideoStatus.DRAFT,
    size_bytes: VIDEO_PART_SIZE_BYTES + 1, // partCount 2
    upload_id: UPLOAD_ID,
    ...overrides,
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
  let storage: StorageServiceMock;
  let lifecycle: LifecycleServiceMock;
  let processingQueue: ProcessingQueueMock;

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
      presignUploadPart: jest.fn() as StorageServiceMock['presignUploadPart'],
      listParts: jest.fn() as StorageServiceMock['listParts'],
      deleteObject: jest.fn() as StorageServiceMock['deleteObject'],
      completeMultipartUpload:
        jest.fn() as StorageServiceMock['completeMultipartUpload'],
      headObject: jest.fn() as StorageServiceMock['headObject'],
      presignGetObject: jest.fn() as StorageServiceMock['presignGetObject'],
    };
    storage.createMultipartUpload.mockResolvedValue(UPLOAD_ID);
    storage.abortMultipartUpload.mockResolvedValue(undefined);
    storage.deleteObject.mockResolvedValue(undefined);
    lifecycle = {
      failDraft: jest.fn() as LifecycleServiceMock['failDraft'],
      markProcessing: jest.fn() as LifecycleServiceMock['markProcessing'],
    };
    lifecycle.failDraft.mockResolvedValue(true);
    lifecycle.markProcessing.mockResolvedValue(true);
    processingQueue = {
      enqueue: jest.fn() as ProcessingQueueMock['enqueue'],
    };
    processingQueue.enqueue.mockResolvedValue(undefined);

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
        { provide: VideoLifecycleService, useValue: lifecycle },
        { provide: VideoProcessingQueue, useValue: processingQueue },
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

  describe('signUploadParts', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('should presign every requested part with the 1 h TTL and expire in 3600 s', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-07T12:00:00.000Z') });
      videoRepository.findOne.mockResolvedValue(makeVideo());
      storage.presignUploadPart.mockImplementation(
        (_key, _uploadId, partNumber) =>
          Promise.resolve(`https://storage.test/part-${partNumber}`),
      );

      const result = await service.signUploadParts(USER_ID, VIDEO_ID, [1, 2]);

      expect(result).toEqual({
        parts: [
          { partNumber: 1, url: 'https://storage.test/part-1' },
          { partNumber: 2, url: 'https://storage.test/part-2' },
        ],
        expiresAt: '2026-11-07T13:00:00.000Z',
      });
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        VIDEO_KEY,
        UPLOAD_ID,
        1,
        UPLOAD_PART_URL_TTL_SECONDS,
      );
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        VIDEO_KEY,
        UPLOAD_ID,
        2,
        UPLOAD_PART_URL_TTL_SECONDS,
      );
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should throw VideoUploadNotActiveException for a %s video without signing',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(makeVideo({ status }));

        await expect(
          service.signUploadParts(USER_ID, VIDEO_ID, [1]),
        ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
        expect(storage.presignUploadPart).not.toHaveBeenCalled();
      },
    );

    it('should throw UploadPartsInvalidException when a part number is above partCount, signing nothing', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());

      await expect(
        service.signUploadParts(USER_ID, VIDEO_ID, [1, 3]),
      ).rejects.toBeInstanceOf(UploadPartsInvalidException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should propagate VideoNotFoundException for a video the caller does not own', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.signUploadParts(USER_ID, VIDEO_ID, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('listUploadedParts', () => {
    it('should return the stored parts of the draft upload', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      const parts = [{ partNumber: 1, etag: '"abc"', size: 1024 }];
      storage.listParts.mockResolvedValue(parts);

      await expect(
        service.listUploadedParts(USER_ID, VIDEO_ID),
      ).resolves.toEqual({ parts });
      expect(storage.listParts).toHaveBeenCalledWith(VIDEO_KEY, UPLOAD_ID);
    });

    it('should throw VideoUploadNotActiveException for a non-draft video without calling storage', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.listUploadedParts(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('should map UploadSessionNotFoundError to VideoUploadNotActiveException', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      storage.listParts.mockRejectedValue(
        new UploadSessionNotFoundError(VIDEO_KEY, UPLOAD_ID),
      );

      await expect(
        service.listUploadedParts(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
    });

    it('should rethrow any other storage error unchanged', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      const failure = new Error('connection reset');
      storage.listParts.mockRejectedValue(failure);

      await expect(service.listUploadedParts(USER_ID, VIDEO_ID)).rejects.toBe(
        failure,
      );
    });
  });

  describe('abortUpload', () => {
    it('should abort the session, then delete the original, then fail the draft as UPLOAD_ABORTED', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      const calls: string[] = [];
      storage.abortMultipartUpload.mockImplementation(() => {
        calls.push('abort');
        return Promise.resolve();
      });
      storage.deleteObject.mockImplementation(() => {
        calls.push('delete');
        return Promise.resolve();
      });
      lifecycle.failDraft.mockImplementation(() => {
        calls.push('failDraft');
        return Promise.resolve(true);
      });

      await expect(
        service.abortUpload(USER_ID, VIDEO_ID),
      ).resolves.toBeUndefined();

      expect(calls).toEqual(['abort', 'delete', 'failDraft']);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        VIDEO_KEY,
        UPLOAD_ID,
      );
      expect(storage.deleteObject).toHaveBeenCalledWith(VIDEO_KEY);
      expect(lifecycle.failDraft).toHaveBeenCalledWith(
        VIDEO_ID,
        'UPLOAD_ABORTED',
      );
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should throw VideoUploadNotActiveException for a %s video without storage calls or status write',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(
          makeVideo({ status, upload_id: null }),
        );

        await expect(
          service.abortUpload(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
        expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
        expect(storage.deleteObject).not.toHaveBeenCalled();
        expect(lifecycle.failDraft).not.toHaveBeenCalled();
      },
    );

    it('should throw VideoUploadNotActiveException when the guarded update matches no row', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      lifecycle.failDraft.mockResolvedValue(false);

      await expect(
        service.abortUpload(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
      expect(storage.abortMultipartUpload).toHaveBeenCalled();
      expect(storage.deleteObject).toHaveBeenCalled();
    });

    it('should propagate VideoNotFoundException for a video the caller does not own', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.abortUpload(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should rethrow a storage failure and leave the row untouched', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      const failure = new Error('connection reset');
      storage.deleteObject.mockRejectedValue(failure);

      await expect(service.abortUpload(USER_ID, VIDEO_ID)).rejects.toBe(
        failure,
      );
      expect(lifecycle.failDraft).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    const SLUG = 'abcdefghijk';
    const SIZE = VIDEO_PART_SIZE_BYTES + 1; // partCount 2
    const PARTS = [
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ];
    const STARTED = { id: VIDEO_ID, slug: SLUG, status: 'processing' };

    function makeDraft(overrides: Partial<Video> = {}): Video {
      return makeVideo({ slug: SLUG, size_bytes: SIZE, ...overrides });
    }

    beforeEach(() => {
      storage.completeMultipartUpload.mockResolvedValue(undefined);
      storage.headObject.mockResolvedValue({ size: SIZE });
    });

    it('should complete, check the size, mark processing and enqueue, in that order', async () => {
      videoRepository.findOne.mockResolvedValue(makeDraft());
      const calls: string[] = [];
      storage.completeMultipartUpload.mockImplementation(() => {
        calls.push('complete');
        return Promise.resolve();
      });
      storage.headObject.mockImplementation(() => {
        calls.push('head');
        return Promise.resolve({ size: SIZE });
      });
      lifecycle.markProcessing.mockImplementation(() => {
        calls.push('markProcessing');
        return Promise.resolve(true);
      });
      processingQueue.enqueue.mockImplementation(() => {
        calls.push('enqueue');
        return Promise.resolve();
      });

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).resolves.toEqual(STARTED);

      expect(calls).toEqual(['complete', 'head', 'markProcessing', 'enqueue']);
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        VIDEO_KEY,
        UPLOAD_ID,
        PARTS,
      );
      expect(storage.headObject).toHaveBeenCalledWith(VIDEO_KEY);
      expect(lifecycle.markProcessing).toHaveBeenCalledWith(VIDEO_ID);
      expect(processingQueue.enqueue).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('should re-enqueue and return the same body for a processing video without storage calls', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeDraft({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).resolves.toEqual(STARTED);

      expect(processingQueue.enqueue).toHaveBeenCalledWith(VIDEO_ID);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(lifecycle.markProcessing).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.READY, VideoStatus.FAILED])(
      'should throw VideoUploadNotActiveException for a %s video without side effects',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(
          makeDraft({ status, upload_id: null }),
        );

        await expect(
          service.completeUpload(USER_ID, VIDEO_ID, PARTS),
        ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
        expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
        expect(processingQueue.enqueue).not.toHaveBeenCalled();
      },
    );

    it('should propagate VideoNotFoundException for a video the caller does not own', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(processingQueue.enqueue).not.toHaveBeenCalled();
    });

    it.each([
      ['fewer parts than partCount', [{ partNumber: 1, etag: '"a"' }]],
      ['parts in descending order', [...PARTS].reverse()],
      [
        'a gap in the part numbers',
        [
          { partNumber: 1, etag: '"a"' },
          { partNumber: 3, etag: '"c"' },
        ],
      ],
      ['more parts than partCount', [...PARTS, { partNumber: 3, etag: '"c"' }]],
    ])(
      'should throw UploadPartsInvalidException for %s before calling storage',
      async (_label, parts) => {
        videoRepository.findOne.mockResolvedValue(makeDraft());

        await expect(
          service.completeUpload(USER_ID, VIDEO_ID, parts),
        ).rejects.toBeInstanceOf(UploadPartsInvalidException);
        expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
        expect(lifecycle.markProcessing).not.toHaveBeenCalled();
      },
    );

    it('should map storage InvalidPart to UploadPartsInvalidException and keep the draft', async () => {
      videoRepository.findOne.mockResolvedValue(makeDraft());
      storage.completeMultipartUpload.mockRejectedValue(
        new InvalidUploadPartsError(VIDEO_KEY, UPLOAD_ID),
      );

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).rejects.toBeInstanceOf(UploadPartsInvalidException);
      expect(storage.headObject).not.toHaveBeenCalled();
      expect(lifecycle.failDraft).not.toHaveBeenCalled();
      expect(lifecycle.markProcessing).not.toHaveBeenCalled();
    });

    it('should keep the upload session resumable when storage rejects undersized parts (EntityTooSmall)', async () => {
      videoRepository.findOne.mockResolvedValue(makeDraft());
      storage.completeMultipartUpload.mockRejectedValue(
        new InvalidUploadPartsError(VIDEO_KEY, UPLOAD_ID, {
          cause: Object.assign(new Error('too small'), {
            name: 'EntityTooSmall',
          }),
        }),
      );

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).rejects.toBeInstanceOf(UploadPartsInvalidException);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(lifecycle.failDraft).not.toHaveBeenCalled();
      expect(processingQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should continue from the size check when the session is gone but the object exists', async () => {
      videoRepository.findOne.mockResolvedValue(makeDraft());
      storage.completeMultipartUpload.mockRejectedValue(
        new UploadSessionNotFoundError(VIDEO_KEY, UPLOAD_ID),
      );

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).resolves.toEqual(STARTED);
      expect(lifecycle.markProcessing).toHaveBeenCalledWith(VIDEO_ID);
      expect(processingQueue.enqueue).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('should throw VideoUploadNotActiveException when the session is gone and no object exists', async () => {
      videoRepository.findOne.mockResolvedValue(makeDraft());
      storage.completeMultipartUpload.mockRejectedValue(
        new UploadSessionNotFoundError(VIDEO_KEY, UPLOAD_ID),
      );
      storage.headObject.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
      expect(lifecycle.failDraft).not.toHaveBeenCalled();
      expect(lifecycle.markProcessing).not.toHaveBeenCalled();
      expect(processingQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should rethrow any other storage error without status writes', async () => {
      videoRepository.findOne.mockResolvedValue(makeDraft());
      const failure = new Error('connection reset');
      storage.completeMultipartUpload.mockRejectedValue(failure);

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).rejects.toBe(failure);
      expect(lifecycle.markProcessing).not.toHaveBeenCalled();
      expect(lifecycle.failDraft).not.toHaveBeenCalled();
    });

    it('should delete the object, fail the draft and throw UploadSizeMismatchException on a size mismatch', async () => {
      videoRepository.findOne.mockResolvedValue(makeDraft());
      storage.headObject.mockResolvedValue({ size: SIZE - 1 });
      const calls: string[] = [];
      storage.deleteObject.mockImplementation(() => {
        calls.push('delete');
        return Promise.resolve();
      });
      lifecycle.failDraft.mockImplementation(() => {
        calls.push('failDraft');
        return Promise.resolve(true);
      });

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(calls).toEqual(['delete', 'failDraft']);
      expect(storage.deleteObject).toHaveBeenCalledWith(VIDEO_KEY);
      expect(lifecycle.failDraft).toHaveBeenCalledWith(
        VIDEO_ID,
        'UPLOAD_SIZE_MISMATCH',
      );
      expect(lifecycle.markProcessing).not.toHaveBeenCalled();
      expect(processingQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should treat a guarded-update miss as success when a concurrent call already moved the video to processing', async () => {
      videoRepository.findOne
        .mockResolvedValueOnce(makeDraft())
        .mockResolvedValueOnce(
          makeDraft({ status: VideoStatus.PROCESSING, upload_id: null }),
        );
      lifecycle.markProcessing.mockResolvedValue(false);

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).resolves.toEqual(STARTED);
      expect(processingQueue.enqueue).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('should throw VideoUploadNotActiveException and not enqueue when a guarded-update miss leaves the video in another status', async () => {
      videoRepository.findOne
        .mockResolvedValueOnce(makeDraft())
        .mockResolvedValueOnce(
          makeDraft({
            status: VideoStatus.FAILED,
            failure_reason: 'UPLOAD_ABORTED',
            upload_id: null,
          }),
        );
      lifecycle.markProcessing.mockResolvedValue(false);

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, PARTS),
      ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
      expect(processingQueue.enqueue).not.toHaveBeenCalled();
    });
  });

  // ParseUUIDPipe accepts any case and Postgres matches a `uuid` in any case,
  // so the request id may be uppercase; storage, queue and lifecycle calls
  // must always use the loaded entity's canonical (lowercase) id.
  describe('uppercase request id', () => {
    const UPPER_ID = VIDEO_ID.toUpperCase();
    const SIZE = VIDEO_PART_SIZE_BYTES + 1; // partCount 2
    const PARTS = [
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ];

    it('should sign parts for the canonical key', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      storage.presignUploadPart.mockResolvedValue('http://signed');

      await service.signUploadParts(USER_ID, UPPER_ID, [1]);

      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        VIDEO_KEY,
        UPLOAD_ID,
        1,
        UPLOAD_PART_URL_TTL_SECONDS,
      );
    });

    it('should list parts of the canonical key', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      storage.listParts.mockResolvedValue([]);

      await service.listUploadedParts(USER_ID, UPPER_ID);

      expect(storage.listParts).toHaveBeenCalledWith(VIDEO_KEY, UPLOAD_ID);
    });

    it('should abort, delete and fail the draft with the canonical id', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());

      await service.abortUpload(USER_ID, UPPER_ID);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        VIDEO_KEY,
        UPLOAD_ID,
      );
      expect(storage.deleteObject).toHaveBeenCalledWith(VIDEO_KEY);
      expect(lifecycle.failDraft).toHaveBeenCalledWith(
        VIDEO_ID,
        'UPLOAD_ABORTED',
      );
    });

    it('should complete, mark processing and enqueue with the canonical id', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ slug: 'abcdefghijk', size_bytes: SIZE }),
      );
      storage.completeMultipartUpload.mockResolvedValue(undefined);
      storage.headObject.mockResolvedValue({ size: SIZE });

      const result = await service.completeUpload(USER_ID, UPPER_ID, PARTS);

      expect(result.id).toBe(VIDEO_ID);
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        VIDEO_KEY,
        UPLOAD_ID,
        PARTS,
      );
      expect(storage.headObject).toHaveBeenCalledWith(VIDEO_KEY);
      expect(lifecycle.markProcessing).toHaveBeenCalledWith(VIDEO_ID);
      expect(processingQueue.enqueue).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('should re-enqueue a processing video under the canonical job id', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      const result = await service.completeUpload(USER_ID, UPPER_ID, PARTS);

      expect(result.id).toBe(VIDEO_ID);
      expect(processingQueue.enqueue).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('should delete and fail with the canonical id on a size mismatch', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ size_bytes: SIZE }),
      );
      storage.completeMultipartUpload.mockResolvedValue(undefined);
      storage.headObject.mockResolvedValue({ size: SIZE + 1 });

      await expect(
        service.completeUpload(USER_ID, UPPER_ID, PARTS),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storage.deleteObject).toHaveBeenCalledWith(VIDEO_KEY);
      expect(lifecycle.failDraft).toHaveBeenCalledWith(
        VIDEO_ID,
        'UPLOAD_SIZE_MISMATCH',
      );
    });
  });

  describe('getPlaybackUrl', () => {
    const SLUG = 'AbCdEfGhIjK';
    const PRESIGNED_URL =
      'http://storage.test/videos/x/original?X-Amz-Expires=3600';

    function makeReadyVideo(): Video {
      return makeVideo({
        slug: SLUG,
        status: VideoStatus.READY,
        upload_id: null,
        title: 'Férias: dia 1/2',
        original_filename: 'clip.MP4',
      });
    }

    it('should look up only a ready video by slug', async () => {
      videoRepository.findOne.mockResolvedValue(makeReadyVideo());
      storage.presignGetObject.mockResolvedValue(PRESIGNED_URL);

      await service.getPlaybackUrl(SLUG, 'stream');

      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { slug: SLUG, status: VideoStatus.READY },
      });
    });

    it('should presign a public 1 h GET of the original without a disposition for stream', async () => {
      videoRepository.findOne.mockResolvedValue(makeReadyVideo());
      storage.presignGetObject.mockResolvedValue(PRESIGNED_URL);

      const url = await service.getPlaybackUrl(SLUG, 'stream');

      expect(url).toBe(PRESIGNED_URL);
      expect(storage.presignGetObject).toHaveBeenCalledWith(VIDEO_KEY, {
        client: 'public',
        expiresIn: PLAYBACK_URL_TTL_SECONDS,
        responseContentDisposition: undefined,
      });
    });

    it('should pass the attachment disposition built from title and original filename for download', async () => {
      videoRepository.findOne.mockResolvedValue(makeReadyVideo());
      storage.presignGetObject.mockResolvedValue(PRESIGNED_URL);

      const url = await service.getPlaybackUrl(SLUG, 'download');

      expect(url).toBe(PRESIGNED_URL);
      expect(storage.presignGetObject).toHaveBeenCalledWith(VIDEO_KEY, {
        client: 'public',
        expiresIn: PLAYBACK_URL_TTL_SECONDS,
        responseContentDisposition:
          'attachment; filename="F_rias dia 12.mp4"; filename*=UTF-8\'\'F%C3%A9rias%20dia%2012.mp4',
      });
    });

    // `draft`/`processing`/`failed` rows never match the `status: ready`
    // filter, so the repository answers null just as for an unknown slug.
    it.each([
      ['an unknown slug', 'stream'],
      ['a draft video', 'stream'],
      ['a processing video', 'download'],
      ['a failed video', 'download'],
    ] as const)(
      'should throw VideoNotFoundException for %s (%s) without presigning',
      async (_case, mode) => {
        videoRepository.findOne.mockResolvedValue(null);

        await expect(service.getPlaybackUrl(SLUG, mode)).rejects.toBeInstanceOf(
          VideoNotFoundException,
        );
        expect(storage.presignGetObject).not.toHaveBeenCalled();
      },
    );
  });
});
