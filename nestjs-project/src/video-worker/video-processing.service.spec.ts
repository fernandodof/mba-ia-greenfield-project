import { Test } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { FfmpegService } from '../media/ffmpeg.service';
import { InvalidMediaError, TransientMediaError } from '../media/media.errors';
import { StorageService } from '../storage/storage.service';
import type { MockedMethods } from '../test/mocked-methods';
import type { Video } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { WORKER_SOURCE_URL_TTL_SECONDS } from '../videos/video.constants';
import { VideoStatus } from '../videos/video.types';
import { VideoProcessingFailure } from './video-processing.errors';
import {
  thumbnailOffsetSeconds,
  VideoProcessingService,
} from './video-processing.service';

const VIDEO_ID = '0b0f6a4e-3c39-4a64-9a39-2f2f5ad2d1a1';
const SOURCE_URL = 'http://minio:9000/streamtube-videos/signed';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const METADATA = {
  durationMs: 10000,
  width: 320,
  height: 240,
  videoCodec: 'h264',
};

function videoWith(status: VideoStatus): Video {
  return { id: VIDEO_ID, status } as Video;
}

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let lifecycle: Pick<
    MockedMethods<VideoLifecycleService>,
    'findById' | 'markReady'
  >;
  let storage: Pick<
    MockedMethods<StorageService>,
    'headObject' | 'presignGetObject' | 'putObject'
  >;
  let ffmpeg: MockedMethods<FfmpegService>;

  beforeEach(async () => {
    lifecycle = {
      findById: jest.fn() as MockedMethods<VideoLifecycleService>['findById'],
      markReady: jest.fn() as MockedMethods<VideoLifecycleService>['markReady'],
    };
    storage = {
      headObject: jest.fn() as MockedMethods<StorageService>['headObject'],
      presignGetObject:
        jest.fn() as MockedMethods<StorageService>['presignGetObject'],
      putObject: jest.fn() as MockedMethods<StorageService>['putObject'],
    };
    ffmpeg = {
      probe: jest.fn() as MockedMethods<FfmpegService>['probe'],
      extractFrame: jest.fn() as MockedMethods<FfmpegService>['extractFrame'],
    };

    lifecycle.findById.mockResolvedValue(videoWith(VideoStatus.PROCESSING));
    lifecycle.markReady.mockResolvedValue(true);
    storage.headObject.mockResolvedValue({ size: 1024 });
    storage.presignGetObject.mockResolvedValue(SOURCE_URL);
    storage.putObject.mockResolvedValue(undefined);
    ffmpeg.probe.mockResolvedValue(METADATA);
    ffmpeg.extractFrame.mockResolvedValue(JPEG);

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: VideoLifecycleService, useValue: lifecycle },
        { provide: StorageService, useValue: storage },
        { provide: FfmpegService, useValue: ffmpeg },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
  });

  async function expectFailure(reason: string): Promise<void> {
    const error = await service.process(VIDEO_ID).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(VideoProcessingFailure);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ reason });
  }

  it('should probe the original through a fresh internal URL, store the thumbnail and mark the video ready', async () => {
    await service.process(VIDEO_ID);

    expect(storage.headObject).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/original`,
    );
    expect(storage.presignGetObject).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/original`,
      { client: 'internal', expiresIn: WORKER_SOURCE_URL_TTL_SECONDS },
    );
    expect(ffmpeg.probe).toHaveBeenCalledWith(SOURCE_URL);
    expect(ffmpeg.extractFrame).toHaveBeenCalledWith(SOURCE_URL, 1);
    expect(storage.putObject).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/thumbnail.jpg`,
      JPEG,
      'image/jpeg',
    );
    expect(lifecycle.markReady).toHaveBeenCalledWith(VIDEO_ID, {
      ...METADATA,
      thumbnailKey: `videos/${VIDEO_ID}/thumbnail.jpg`,
    });
  });

  it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
    'should do nothing when the video is %s (redelivered job)',
    async (status) => {
      lifecycle.findById.mockResolvedValue(videoWith(status));

      await expect(service.process(VIDEO_ID)).resolves.toBeUndefined();

      expect(storage.headObject).not.toHaveBeenCalled();
      expect(ffmpeg.probe).not.toHaveBeenCalled();
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(lifecycle.markReady).not.toHaveBeenCalled();
    },
  );

  it('should do nothing when the video no longer exists', async () => {
    lifecycle.findById.mockResolvedValue(null);

    await expect(service.process(VIDEO_ID)).resolves.toBeUndefined();

    expect(storage.headObject).not.toHaveBeenCalled();
    expect(lifecycle.markReady).not.toHaveBeenCalled();
  });

  it('should fail with SOURCE_MISSING when the original does not exist', async () => {
    storage.headObject.mockResolvedValue(null);

    await expectFailure('SOURCE_MISSING');

    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(lifecycle.markReady).not.toHaveBeenCalled();
  });

  it('should rethrow a HeadObject error as a retryable error', async () => {
    const networkError = new Error('socket hang up');
    storage.headObject.mockRejectedValue(networkError);

    await expect(service.process(VIDEO_ID)).rejects.toBe(networkError);
    expect(ffmpeg.probe).not.toHaveBeenCalled();
  });

  it('should fail with INVALID_MEDIA when ffprobe reports invalid media', async () => {
    ffmpeg.probe.mockRejectedValue(new InvalidMediaError('Invalid data'));

    await expectFailure('INVALID_MEDIA');

    expect(ffmpeg.extractFrame).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(lifecycle.markReady).not.toHaveBeenCalled();
  });

  it('should rethrow a transient probe error as-is (retryable)', async () => {
    const transient = new TransientMediaError('Connection refused');
    ffmpeg.probe.mockRejectedValue(transient);

    const error = await service.process(VIDEO_ID).catch((err: unknown) => err);

    expect(error).toBe(transient);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(lifecycle.markReady).not.toHaveBeenCalled();
  });

  it('should retry the frame at t = 0 when no frame comes back at t > 0', async () => {
    ffmpeg.extractFrame.mockResolvedValueOnce(null).mockResolvedValueOnce(JPEG);

    await service.process(VIDEO_ID);

    expect(ffmpeg.extractFrame).toHaveBeenNthCalledWith(1, SOURCE_URL, 1);
    expect(ffmpeg.extractFrame).toHaveBeenNthCalledWith(2, SOURCE_URL, 0);
    expect(storage.putObject).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/thumbnail.jpg`,
      JPEG,
      'image/jpeg',
    );
    expect(lifecycle.markReady).toHaveBeenCalled();
  });

  it('should fail with THUMBNAIL_FAILED when neither offset yields a frame', async () => {
    ffmpeg.extractFrame.mockResolvedValue(null);

    await expectFailure('THUMBNAIL_FAILED');

    expect(ffmpeg.extractFrame).toHaveBeenCalledTimes(2);
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(lifecycle.markReady).not.toHaveBeenCalled();
  });

  it('should rethrow a transient frame error at t > 0 without the t = 0 fallback', async () => {
    const transient = new TransientMediaError('Server returned 503');
    ffmpeg.extractFrame.mockRejectedValue(transient);

    await expect(service.process(VIDEO_ID)).rejects.toBe(transient);

    expect(ffmpeg.extractFrame).toHaveBeenCalledTimes(1);
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('should rethrow a thumbnail upload error as a retryable error', async () => {
    const storageError = new Error('InternalError');
    storage.putObject.mockRejectedValue(storageError);

    await expect(service.process(VIDEO_ID)).rejects.toBe(storageError);
    expect(lifecycle.markReady).not.toHaveBeenCalled();
  });

  it('should resolve without throwing when the video left processing before markReady', async () => {
    lifecycle.markReady.mockResolvedValue(false);

    await expect(service.process(VIDEO_ID)).resolves.toBeUndefined();
  });

  it.each([
    [400, 0.2],
    [2000, 1],
    [10000, 1],
  ])(
    'should take the frame for a %i ms video at t = %d s',
    async (durationMs, t) => {
      ffmpeg.probe.mockResolvedValue({ ...METADATA, durationMs });

      await service.process(VIDEO_ID);

      expect(ffmpeg.extractFrame).toHaveBeenCalledWith(SOURCE_URL, t);
    },
  );
});

describe('thumbnailOffsetSeconds', () => {
  it.each([
    [400, 0.2],
    [1000, 0.5],
    [2000, 1],
    [10000, 1],
  ])('should map %i ms to %d s', (durationMs, expected) => {
    expect(thumbnailOffsetSeconds(durationMs)).toBe(expected);
  });
});
