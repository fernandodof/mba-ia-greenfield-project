import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UnrecoverableError, type Job } from 'bullmq';
import videoConfig from '../config/video.config';
import type { MockedMethods } from '../test/mocked-methods';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import type { VideoProcessingJobData } from '../videos/video-queue.constants';
import { VideoProcessingFailure } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

const VIDEO_ID = '0b0f6a4e-3c39-4a64-9a39-2f2f5ad2d1a1';

function jobWith(
  data: unknown,
  attemptsMade: number,
  opts: { attempts?: number } = { attempts: 3 },
): Job<VideoProcessingJobData> {
  return {
    data,
    attemptsMade,
    opts,
  } as unknown as Job<VideoProcessingJobData>;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let processing: MockedMethods<VideoProcessingService>;
  let lifecycle: Pick<
    MockedMethods<VideoLifecycleService>,
    'markProcessingFailed'
  >;
  let errorLog: jest.SpyInstance;

  async function createProcessor(workerConcurrency = 1): Promise<void> {
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: VideoProcessingService, useValue: processing },
        { provide: VideoLifecycleService, useValue: lifecycle },
        { provide: videoConfig.KEY, useValue: { workerConcurrency } },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  }

  beforeEach(async () => {
    processing = {
      process: jest.fn() as MockedMethods<VideoProcessingService>['process'],
    };
    lifecycle = {
      markProcessingFailed:
        jest.fn() as MockedMethods<VideoLifecycleService>['markProcessingFailed'],
    };
    lifecycle.markProcessingFailed.mockResolvedValue(true);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await createProcessor();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('process', () => {
    it('delegates to the processing service with the job videoId', async () => {
      processing.process.mockResolvedValue(undefined);

      await processor.process(jobWith({ videoId: VIDEO_ID }, 0));

      expect(processing.process).toHaveBeenCalledWith(VIDEO_ID);
    });
  });

  describe('onFailed', () => {
    it('writes nothing when the job is undefined', async () => {
      await processor.onFailed(undefined, new UnrecoverableError('stalled'));

      expect(lifecycle.markProcessingFailed).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', {}],
      ['empty', { videoId: '' }],
      ['non-string', { videoId: 42 }],
      ['no data', undefined],
    ])(
      'writes nothing when videoId is %s',
      async (_label: string, data: unknown) => {
        await processor.onFailed(
          jobWith(data, 3),
          new VideoProcessingFailure('INVALID_MEDIA'),
        );

        expect(lifecycle.markProcessingFailed).not.toHaveBeenCalled();
      },
    );

    it.each([1, 2])(
      'writes nothing after a transient failure on attempt %i of 3',
      async (attemptsMade: number) => {
        await processor.onFailed(
          jobWith({ videoId: VIDEO_ID }, attemptsMade),
          new Error('Connection refused'),
        );

        expect(lifecycle.markProcessingFailed).not.toHaveBeenCalled();
      },
    );

    it('records PROCESSING_FAILED after a transient failure on the last attempt', async () => {
      await processor.onFailed(
        jobWith({ videoId: VIDEO_ID }, 3),
        new Error('Connection refused'),
      );

      expect(lifecycle.markProcessingFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'PROCESSING_FAILED',
      );
    });

    it('treats a job without attempts as a single-attempt job', async () => {
      await processor.onFailed(
        jobWith({ videoId: VIDEO_ID }, 1, {}),
        new Error('boom'),
      );

      expect(lifecycle.markProcessingFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'PROCESSING_FAILED',
      );
    });

    it('records PROCESSING_FAILED for an UnrecoverableError detected by name only', async () => {
      const error = new Error('gave up');
      error.name = 'UnrecoverableError';

      await processor.onFailed(jobWith({ videoId: VIDEO_ID }, 1), error);

      expect(lifecycle.markProcessingFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'PROCESSING_FAILED',
      );
    });

    it('records PROCESSING_FAILED for a plain UnrecoverableError', async () => {
      await processor.onFailed(
        jobWith({ videoId: VIDEO_ID }, 1),
        new UnrecoverableError('max started attempts'),
      );

      expect(lifecycle.markProcessingFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'PROCESSING_FAILED',
      );
    });

    it.each(['INVALID_MEDIA', 'THUMBNAIL_FAILED', 'SOURCE_MISSING'] as const)(
      'records the %s reason of a VideoProcessingFailure on the first attempt',
      async (reason) => {
        await processor.onFailed(
          jobWith({ videoId: VIDEO_ID }, 1),
          new VideoProcessingFailure(reason),
        );

        expect(lifecycle.markProcessingFailed).toHaveBeenCalledWith(
          VIDEO_ID,
          reason,
        );
      },
    );

    it('resolves when the row is no longer processing', async () => {
      lifecycle.markProcessingFailed.mockResolvedValue(false);

      await expect(
        processor.onFailed(
          jobWith({ videoId: VIDEO_ID }, 1),
          new VideoProcessingFailure('INVALID_MEDIA'),
        ),
      ).resolves.toBeUndefined();
    });

    it('logs and does not rethrow when the lifecycle write throws', async () => {
      lifecycle.markProcessingFailed.mockRejectedValue(
        new Error('connection terminated'),
      );

      await expect(
        processor.onFailed(
          jobWith({ videoId: VIDEO_ID }, 1),
          new VideoProcessingFailure('SOURCE_MISSING'),
        ),
      ).resolves.toBeUndefined();

      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining(VIDEO_ID),
        expect.stringContaining('connection terminated'),
      );
    });
  });

  describe('onApplicationBootstrap', () => {
    it.each([1, 2, 4])(
      'sets worker.concurrency to the configured value %i',
      async (workerConcurrency: number) => {
        await createProcessor(workerConcurrency);
        const worker = { concurrency: 1 };
        // WorkerHost's `worker` getter reads the instance assigned by the
        // BullMQ explorer at module init.
        Object.assign(processor, { _worker: worker });

        processor.onApplicationBootstrap();

        expect(worker.concurrency).toBe(workerConcurrency);
      },
    );
  });
});
