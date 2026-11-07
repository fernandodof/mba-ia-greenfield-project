import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import type { MockedMethods } from '../test/mocked-methods';
import type { Video } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import {
  VideoProcessingQueue,
  type VideoProcessingJobState,
} from '../videos/video-processing.queue';
import { VideoSweeperService } from './video-sweeper.service';

const STUCK_AFTER_MS = 1800000;
const EXPIRE_AFTER_MS = 86400000;
const STUCK_ID = '5a3c1f40-0b1e-4c9e-9d55-0d1f7e0c1a01';
const DRAFT_A = '5a3c1f40-0b1e-4c9e-9d55-0d1f7e0c1a02';
const DRAFT_B = '5a3c1f40-0b1e-4c9e-9d55-0d1f7e0c1a03';

function video(id: string, uploadId: string | null = null): Video {
  return { id, upload_id: uploadId } as Video;
}

describe('VideoSweeperService', () => {
  let service: VideoSweeperService;
  let lifecycle: Pick<
    MockedMethods<VideoLifecycleService>,
    | 'findStuckProcessing'
    | 'findExpiredDrafts'
    | 'markProcessingFailed'
    | 'failDraft'
  >;
  let queue: MockedMethods<VideoProcessingQueue>;
  let storage: Pick<
    MockedMethods<StorageService>,
    'abortMultipartUpload' | 'deleteObject'
  >;
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    lifecycle = {
      findStuckProcessing:
        jest.fn() as MockedMethods<VideoLifecycleService>['findStuckProcessing'],
      findExpiredDrafts:
        jest.fn() as MockedMethods<VideoLifecycleService>['findExpiredDrafts'],
      markProcessingFailed:
        jest.fn() as MockedMethods<VideoLifecycleService>['markProcessingFailed'],
      failDraft: jest.fn() as MockedMethods<VideoLifecycleService>['failDraft'],
    };
    queue = {
      enqueue: jest.fn() as MockedMethods<VideoProcessingQueue>['enqueue'],
      getJobState:
        jest.fn() as MockedMethods<VideoProcessingQueue>['getJobState'],
      removeJob: jest.fn() as MockedMethods<VideoProcessingQueue>['removeJob'],
    };
    storage = {
      abortMultipartUpload:
        jest.fn() as MockedMethods<StorageService>['abortMultipartUpload'],
      deleteObject: jest.fn() as MockedMethods<StorageService>['deleteObject'],
    };
    lifecycle.findStuckProcessing.mockResolvedValue([]);
    lifecycle.findExpiredDrafts.mockResolvedValue([]);
    lifecycle.markProcessingFailed.mockResolvedValue(true);
    lifecycle.failDraft.mockResolvedValue(true);
    queue.enqueue.mockResolvedValue(undefined);
    queue.removeJob.mockResolvedValue(undefined);
    storage.abortMultipartUpload.mockResolvedValue(undefined);
    storage.deleteObject.mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const module = await Test.createTestingModule({
      providers: [
        VideoSweeperService,
        { provide: VideoLifecycleService, useValue: lifecycle },
        { provide: VideoProcessingQueue, useValue: queue },
        { provide: StorageService, useValue: storage },
        {
          provide: videoConfig.KEY,
          useValue: {
            processingStuckAfterMs: STUCK_AFTER_MS,
            uploadExpireAfterMs: EXPIRE_AFTER_MS,
          },
        },
      ],
    }).compile();
    service = module.get(VideoSweeperService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('queries both branches with the configured thresholds', async () => {
    await service.sweep();

    expect(lifecycle.findStuckProcessing).toHaveBeenCalledWith(STUCK_AFTER_MS);
    expect(lifecycle.findExpiredDrafts).toHaveBeenCalledWith(EXPIRE_AFTER_MS);
  });

  describe('stuck processing', () => {
    beforeEach(() => {
      lifecycle.findStuckProcessing.mockResolvedValue([video(STUCK_ID)]);
    });

    it.each<VideoProcessingJobState>(['missing', 'unknown'])(
      're-enqueues the video when the job is %s',
      async (state) => {
        queue.getJobState.mockResolvedValue(state);

        await service.sweep();

        expect(queue.getJobState).toHaveBeenCalledWith(STUCK_ID);
        expect(queue.enqueue).toHaveBeenCalledWith(STUCK_ID);
        expect(queue.removeJob).not.toHaveBeenCalled();
        expect(lifecycle.markProcessingFailed).not.toHaveBeenCalled();
      },
    );

    it('marks the video failed/PROCESSING_FAILED without re-enqueueing when the job failed', async () => {
      queue.getJobState.mockResolvedValue('failed');

      await service.sweep();

      expect(lifecycle.markProcessingFailed).toHaveBeenCalledWith(
        STUCK_ID,
        'PROCESSING_FAILED',
      );
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(queue.removeJob).not.toHaveBeenCalled();
    });

    it('removes the job and then re-enqueues the video when the job completed', async () => {
      queue.getJobState.mockResolvedValue('completed');

      await service.sweep();

      expect(queue.removeJob).toHaveBeenCalledWith(STUCK_ID);
      expect(queue.enqueue).toHaveBeenCalledWith(STUCK_ID);
      expect(queue.removeJob.mock.invocationCallOrder[0]).toBeLessThan(
        queue.enqueue.mock.invocationCallOrder[0],
      );
      expect(lifecycle.markProcessingFailed).not.toHaveBeenCalled();
    });

    it.each<VideoProcessingJobState>([
      'waiting',
      'delayed',
      'prioritized',
      'active',
      'waiting-children',
    ])('leaves the video alone when the job is %s', async (state) => {
      queue.getJobState.mockResolvedValue(state);

      await service.sweep();

      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(queue.removeJob).not.toHaveBeenCalled();
      expect(lifecycle.markProcessingFailed).not.toHaveBeenCalled();
    });

    it('logs an error on one stuck video and still reconciles the next one and the drafts', async () => {
      const nextId = '5a3c1f40-0b1e-4c9e-9d55-0d1f7e0c1a09';
      lifecycle.findStuckProcessing.mockResolvedValue([
        video(STUCK_ID),
        video(nextId),
      ]);
      queue.getJobState
        .mockRejectedValueOnce(new Error('redis down'))
        .mockResolvedValueOnce('missing');
      lifecycle.findExpiredDrafts.mockResolvedValue([video(DRAFT_A)]);

      await expect(service.sweep()).resolves.toBeUndefined();

      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(queue.enqueue).toHaveBeenCalledWith(nextId);
      expect(lifecycle.failDraft).toHaveBeenCalledWith(
        DRAFT_A,
        'UPLOAD_EXPIRED',
      );
      expect(errorLog).toHaveBeenCalledTimes(1);
    });
  });

  describe('expired drafts', () => {
    it('aborts the upload, then deletes the original, then fails the draft with UPLOAD_EXPIRED', async () => {
      lifecycle.findExpiredDrafts.mockResolvedValue([
        video(DRAFT_A, 'upload-a'),
      ]);

      await service.sweep();

      const key = `videos/${DRAFT_A}/original`;
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        key,
        'upload-a',
      );
      expect(storage.deleteObject).toHaveBeenCalledWith(key);
      expect(lifecycle.failDraft).toHaveBeenCalledWith(
        DRAFT_A,
        'UPLOAD_EXPIRED',
      );
      const abortOrder =
        storage.abortMultipartUpload.mock.invocationCallOrder[0];
      const deleteOrder = storage.deleteObject.mock.invocationCallOrder[0];
      const failOrder = lifecycle.failDraft.mock.invocationCallOrder[0];
      expect(abortOrder).toBeLessThan(deleteOrder);
      expect(deleteOrder).toBeLessThan(failOrder);
    });

    it('skips the abort for a draft without upload_id but still deletes the original and fails it', async () => {
      lifecycle.findExpiredDrafts.mockResolvedValue([video(DRAFT_A, null)]);

      await service.sweep();

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(storage.deleteObject).toHaveBeenCalledWith(
        `videos/${DRAFT_A}/original`,
      );
      expect(lifecycle.failDraft).toHaveBeenCalledWith(
        DRAFT_A,
        'UPLOAD_EXPIRED',
      );
    });

    it('skips a draft whose abort fails and still expires the next draft', async () => {
      lifecycle.findExpiredDrafts.mockResolvedValue([
        video(DRAFT_A, 'upload-a'),
        video(DRAFT_B, 'upload-b'),
      ]);
      storage.abortMultipartUpload.mockRejectedValueOnce(
        new Error('storage unavailable'),
      );

      await expect(service.sweep()).resolves.toBeUndefined();

      expect(storage.deleteObject).not.toHaveBeenCalledWith(
        `videos/${DRAFT_A}/original`,
      );
      expect(lifecycle.failDraft).not.toHaveBeenCalledWith(
        DRAFT_A,
        expect.anything(),
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        `videos/${DRAFT_B}/original`,
        'upload-b',
      );
      expect(lifecycle.failDraft).toHaveBeenCalledWith(
        DRAFT_B,
        'UPLOAD_EXPIRED',
      );
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it('does not fail a draft whose original cannot be deleted', async () => {
      lifecycle.findExpiredDrafts.mockResolvedValue([
        video(DRAFT_A, 'upload-a'),
      ]);
      storage.deleteObject.mockRejectedValueOnce(new Error('storage down'));

      await service.sweep();

      expect(lifecycle.failDraft).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
    });
  });
});
