import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  createTestVideo,
  type TestVideoContainer,
} from '../test/video-fixtures';
import {
  PROBE_MAX_BUFFER_BYTES,
  WORKER_SOURCE_URL_TTL_SECONDS,
} from '../videos/video.constants';
import { FfmpegService } from './ffmpeg.service';
import { MediaModule } from './media.module';
import { InvalidMediaError, TransientMediaError } from './media.errors';

const execFileAsync = promisify(execFile);

// Real ffmpeg/ffprobe (nestjs-api image) reading from the real `minio`
// Compose service through internal presigned GETs (Phase 03 IC-1).

async function decodedJpegSize(
  jpeg: Buffer,
): Promise<{ width: number; height: number }> {
  const path = join(tmpdir(), `streamtube-frame-${randomUUID()}.jpg`);
  await writeFile(path, jpeg);
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      path,
    ]);
    const [stream] = (
      JSON.parse(stdout) as { streams: { width: number; height: number }[] }
    ).streams;
    return { width: stream.width, height: stream.height };
  } finally {
    await rm(path, { force: true });
  }
}

describe('FfmpegService (integration)', () => {
  let module: TestingModule;
  let ffmpeg: FfmpegService;
  let storage: StorageService;
  const createdKeys: string[] = [];
  const tempFiles: string[] = [];

  const uploadAndSign = async (
    body: Buffer,
    contentType: string,
  ): Promise<string> => {
    const key = `videos/${randomUUID()}/original`;
    createdKeys.push(key);
    await storage.putObject(key, body, contentType);
    return storage.presignGetObject(key, {
      client: 'internal',
      expiresIn: WORKER_SOURCE_URL_TTL_SECONDS,
    });
  };

  const uploadTestVideo = async (
    options?: Parameters<typeof createTestVideo>[0],
  ): Promise<string> => {
    const path = await createTestVideo(options);
    tempFiles.push(path);
    return uploadAndSign(await readFile(path), 'video/mp4');
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
        MediaModule,
      ],
    }).compile();
    ffmpeg = module.get(FfmpegService);
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    try {
      await Promise.all([
        ...createdKeys.map((key) => storage.deleteObject(key)),
        ...tempFiles.map((path) => rm(path, { force: true })),
      ]);
    } finally {
      await module.close();
    }
  });

  describe('2 s 320x240 H.264 MP4', () => {
    let url: string;

    beforeAll(async () => {
      url = await uploadTestVideo({ durationSeconds: 2 });
    });

    it('should probe duration, dimensions and codec', async () => {
      const result = await ffmpeg.probe(url);

      expect(Math.abs(result.durationMs - 2000)).toBeLessThanOrEqual(100);
      expect(result).toMatchObject({
        width: 320,
        height: 240,
        videoCodec: 'h264',
      });
    });

    it('should extract a JPEG frame at t = 1 within 1280x720 with even sides', async () => {
      const jpeg = await ffmpeg.extractFrame(url, 1);

      expect(jpeg).not.toBeNull();
      expect(jpeg!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      const { width, height } = await decodedJpegSize(jpeg!);
      expect(width).toBeLessThanOrEqual(1280);
      expect(height).toBeLessThanOrEqual(720);
      expect(width % 2).toBe(0);
      expect(height % 2).toBe(0);
    });
  });

  it('should probe a valid MP4 whose ffprobe JSON exceeds the 1 MiB Node default', async () => {
    const path = await createTestVideo({
      durationSeconds: 2,
      commentBytes: 2 * 1024 * 1024,
    });
    tempFiles.push(path);
    const { stdout: rawJson } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        path,
      ],
      { encoding: 'buffer', maxBuffer: PROBE_MAX_BUFFER_BYTES },
    );
    expect(rawJson.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(rawJson.length).toBeLessThan(PROBE_MAX_BUFFER_BYTES);
    const url = await uploadAndSign(await readFile(path), 'video/mp4');

    const result = await ffmpeg.probe(url);

    expect(Math.abs(result.durationMs - 2000)).toBeLessThanOrEqual(100);
    expect(result).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
    });
  });

  it('should downscale a larger frame to fit 1280x720, keeping the aspect ratio', async () => {
    const url = await uploadTestVideo({
      durationSeconds: 1,
      width: 1920,
      height: 1200,
    });

    const jpeg = await ffmpeg.extractFrame(url, 0);

    expect(jpeg).not.toBeNull();
    await expect(decodedJpegSize(jpeg!)).resolves.toEqual({
      width: 1152,
      height: 720,
    });
  });

  it.each<[TestVideoContainer, string, string]>([
    ['mov', 'video/quicktime', 'h264'],
    ['mkv', 'video/x-matroska', 'h264'],
    ['webm', 'video/webm', 'vp9'],
  ])(
    'should probe and extract a frame from a %s upload (%s)',
    async (container, contentType, videoCodec) => {
      const path = await createTestVideo({ durationSeconds: 1, container });
      tempFiles.push(path);
      const url = await uploadAndSign(await readFile(path), contentType);

      await expect(ffmpeg.probe(url)).resolves.toMatchObject({
        width: 320,
        height: 240,
        videoCodec,
      });
      const jpeg = await ffmpeg.extractFrame(url, 0);
      expect(jpeg?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    },
  );

  describe('uploaded content that points at other URLs (SSRF)', () => {
    let listener: Server;
    let listenerUrl: string;
    const requests: string[] = [];

    beforeAll(async () => {
      listener = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) =>
        listener.listen(0, '127.0.0.1', resolve),
      );
      const { port } = listener.address() as AddressInfo;
      listenerUrl = `http://127.0.0.1:${port}`;
    });

    beforeEach(() => {
      requests.length = 0;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        listener.close((err) => (err ? reject(err) : resolve())),
      );
    });

    // ffprobe/ffmpeg run in this container, so 127.0.0.1 is this process.
    const playlists: Array<[string, () => string]> = [
      [
        'an HLS media playlist',
        () =>
          `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n${listenerUrl}/x.ts\n#EXT-X-ENDLIST\n`,
      ],
      [
        'an HLS master playlist',
        () =>
          `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${listenerUrl}/variant.m3u8\n`,
      ],
      [
        'an ffconcat script',
        () => `ffconcat version 1.0\nfile ${listenerUrl}/x.mp4\n`,
      ],
    ];

    it.each(playlists)(
      'should reject %s as invalid media without fetching its URLs',
      async (_label, content) => {
        const url = await uploadAndSign(Buffer.from(content()), 'video/mp4');

        await expect(ffmpeg.probe(url)).rejects.toBeInstanceOf(
          InvalidMediaError,
        );
        await expect(ffmpeg.extractFrame(url, 0)).resolves.toBeNull();
        expect(requests).toEqual([]);
      },
    );
  });

  it('should fail as invalid media for an object that is not a video', async () => {
    const url = await uploadAndSign(randomBytes(64 * 1024), 'video/mp4');

    await expect(ffmpeg.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('should fail as transient when the host refuses connections', async () => {
    const url = 'http://minio:9/streamtube-videos/videos/missing/original';

    await expect(ffmpeg.probe(url)).rejects.toBeInstanceOf(TransientMediaError);
    await expect(ffmpeg.extractFrame(url, 1)).rejects.toBeInstanceOf(
      TransientMediaError,
    );
  });
});
