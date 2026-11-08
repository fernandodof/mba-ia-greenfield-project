import { Test } from '@nestjs/testing';
import {
  MEDIA_COMMAND_TIMEOUT_MS,
  THUMBNAIL_MAX_BUFFER_BYTES,
} from '../videos/video.constants';
import { FfmpegService } from './ffmpeg.service';
import {
  EXEC_FILE,
  isTransientFfmpegStderr,
  TRANSIENT_FFMPEG_STDERR_PATTERNS,
  type ExecFileFn,
} from './media.constants';
import { InvalidMediaError, TransientMediaError } from './media.errors';

const URL =
  'http://minio:9000/streamtube-videos/videos/x/original?X-Amz-Signature=secret';

type ExecResult = Awaited<ReturnType<ExecFileFn>>;

function ok(stdout: string | Buffer): ExecResult {
  return {
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  };
}

function exitFailure(stderr: string, code = 1): Error {
  return Object.assign(new Error('Command failed'), {
    code,
    killed: false,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(stderr),
  });
}

function timeoutFailure(
  fields: Record<string, unknown> = {
    code: null,
    killed: true,
    signal: 'SIGTERM',
  },
): Error {
  return Object.assign(new Error('Command failed'), {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    ...fields,
  });
}

function probeJson(
  overrides: {
    duration?: unknown;
    streams?: unknown[];
  } = {},
): string {
  return JSON.stringify({
    format: {
      duration: 'duration' in overrides ? overrides.duration : '2.000000',
    },
    streams: overrides.streams ?? [
      { codec_type: 'audio', codec_name: 'aac' },
      { codec_type: 'video', codec_name: 'h264', width: 320, height: 240 },
      { codec_type: 'video', codec_name: 'mjpeg', width: 64, height: 64 },
    ],
  });
}

// Each pattern in mixed case, embedded in a realistic stderr line.
const mixedCase = (s: string): string =>
  Array.from(s)
    .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
    .join('');
const TRANSIENT_STDERR = TRANSIENT_FFMPEG_STDERR_PATTERNS.map((pattern) => [
  pattern,
  `[http @ 0x1] ${mixedCase(pattern)} while reading ${URL}`,
]);

// What FFmpeg 5.1.9 prints when the input whitelists refuse a demuxer or a
// protocol (captured from the real binary).
const REFUSED_INPUT_STDERR = [
  [
    'format',
    `[hls @ 0xaaab0ccf7cc0] Format not on whitelist 'mov,mp4,matroska,webm,avi,flv,mpegts,mpeg,asf,ogg,mxf'\n${URL}: Invalid argument`,
  ],
  [
    'protocol',
    `[file @ 0xaaaaba234150] Protocol 'file' not on whitelist 'http,https,tcp,tls'!\n${URL}: Invalid argument`,
  ],
];

describe('FfmpegService', () => {
  it.each(REFUSED_INPUT_STDERR)(
    'should not treat the refused-%s stderr as transient',
    (_label, stderr) => {
      expect(isTransientFfmpegStderr(stderr)).toBe(false);
    },
  );

  let service: FfmpegService;
  let execFile: jest.Mock<ReturnType<ExecFileFn>, Parameters<ExecFileFn>>;

  beforeEach(async () => {
    execFile = jest.fn<ReturnType<ExecFileFn>, Parameters<ExecFileFn>>();
    const module = await Test.createTestingModule({
      providers: [FfmpegService, { provide: EXEC_FILE, useValue: execFile }],
    }).compile();
    service = module.get(FfmpegService);
  });

  describe('probe', () => {
    it('should run ffprobe with the planned arguments and timeout', async () => {
      execFile.mockResolvedValue(ok(probeJson()));

      await service.probe(URL);

      expect(execFile).toHaveBeenCalledWith(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          '-protocol_whitelist',
          'http,https,tcp,tls',
          '-format_whitelist',
          'mov,mp4,matroska,webm,avi,flv,mpegts,mpeg,asf,ogg,mxf',
          URL,
        ],
        { encoding: 'buffer', timeout: MEDIA_COMMAND_TIMEOUT_MS },
      );
    });

    it('should return metadata of the first video stream', async () => {
      execFile.mockResolvedValue(ok(probeJson()));

      await expect(service.probe(URL)).resolves.toEqual({
        durationMs: 2000,
        width: 320,
        height: 240,
        videoCodec: 'h264',
      });
    });

    it.each([
      ['1.0004', 1000],
      ['1.0005', 1001],
      ['12.3456789', 12346],
    ])('should round duration %s s to %d ms', async (duration, expected) => {
      execFile.mockResolvedValue(ok(probeJson({ duration })));

      await expect(service.probe(URL)).resolves.toMatchObject({
        durationMs: expected,
      });
    });

    it.each(TRANSIENT_STDERR)(
      'should classify stderr containing "%s" (any case) as transient',
      async (_pattern, stderr) => {
        execFile.mockRejectedValue(exitFailure(stderr));

        await expect(service.probe(URL)).rejects.toBeInstanceOf(
          TransientMediaError,
        );
      },
    );

    it.each([
      [
        'killed by the timeout',
        { code: null, killed: true, signal: 'SIGTERM' },
      ],
      ['ETIMEDOUT', { code: 'ETIMEDOUT', killed: false, signal: null }],
    ])(
      'should classify a timeout (%s) as transient',
      async (_label, fields) => {
        execFile.mockRejectedValue(timeoutFailure(fields));

        await expect(service.probe(URL)).rejects.toBeInstanceOf(
          TransientMediaError,
        );
      },
    );

    it('should classify other stderr as invalid media, without the URL signature', async () => {
      execFile.mockRejectedValue(
        exitFailure(`${URL}: Invalid data found when processing input`),
      );

      const error = await service.probe(URL).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InvalidMediaError);
      expect((error as Error).message).toContain('Invalid data found');
      expect((error as Error).message).not.toContain('X-Amz-Signature');
    });

    it.each(REFUSED_INPUT_STDERR)(
      'should classify a refused input (%s) as invalid media',
      async (_label, stderr) => {
        execFile.mockRejectedValue(exitFailure(stderr));

        await expect(service.probe(URL)).rejects.toBeInstanceOf(
          InvalidMediaError,
        );
      },
    );

    it('should rethrow failures that are not a process exit', async () => {
      const spawnError = Object.assign(new Error('spawn ffprobe ENOENT'), {
        code: 'ENOENT',
      });
      execFile.mockRejectedValue(spawnError);

      await expect(service.probe(URL)).rejects.toBe(spawnError);
    });

    it.each([
      ['unparsable JSON', 'not json'],
      ['no video stream', probeJson({ streams: [{ codec_type: 'audio' }] })],
      ['no streams at all', JSON.stringify({ format: { duration: '2' } })],
      ['duration 0', probeJson({ duration: '0.000000' })],
      ['missing duration', probeJson({ duration: undefined })],
      ['non-numeric duration', probeJson({ duration: 'N/A' })],
      [
        'missing dimensions',
        probeJson({ streams: [{ codec_type: 'video', codec_name: 'h264' }] }),
      ],
      [
        'missing codec name',
        probeJson({ streams: [{ codec_type: 'video', width: 2, height: 2 }] }),
      ],
    ])('should reject %s as invalid media', async (_label, stdout) => {
      execFile.mockResolvedValue(ok(stdout));

      await expect(service.probe(URL)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });
  });

  describe('extractFrame', () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

    it('should run ffmpeg with input seeking, the scale filter and the buffer limit', async () => {
      execFile.mockResolvedValue(ok(JPEG));

      await service.extractFrame(URL, 0.5);

      expect(execFile).toHaveBeenCalledWith(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          '0.5',
          '-protocol_whitelist',
          'http,https,tcp,tls',
          '-format_whitelist',
          'mov,mp4,matroska,webm,avi,flv,mpegts,mpeg,asf,ogg,mxf',
          '-i',
          URL,
          '-frames:v',
          '1',
          '-vf',
          "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
          '-q:v',
          '3',
          '-f',
          'mjpeg',
          'pipe:1',
        ],
        {
          encoding: 'buffer',
          timeout: MEDIA_COMMAND_TIMEOUT_MS,
          maxBuffer: THUMBNAIL_MAX_BUFFER_BYTES,
        },
      );
    });

    it('should return the JPEG bytes from stdout', async () => {
      execFile.mockResolvedValue(ok(JPEG));

      await expect(service.extractFrame(URL, 1)).resolves.toEqual(JPEG);
    });

    it('should return null when ffmpeg exits 0 with empty stdout', async () => {
      execFile.mockResolvedValue(ok(Buffer.alloc(0)));

      await expect(service.extractFrame(URL, 1)).resolves.toBeNull();
    });

    it('should return null for a non-transient non-zero exit', async () => {
      execFile.mockRejectedValue(
        exitFailure('Invalid data found when processing input'),
      );

      await expect(service.extractFrame(URL, 1)).resolves.toBeNull();
    });

    it.each(TRANSIENT_STDERR)(
      'should classify stderr containing "%s" (any case) as transient',
      async (_pattern, stderr) => {
        execFile.mockRejectedValue(exitFailure(stderr));

        await expect(service.extractFrame(URL, 1)).rejects.toBeInstanceOf(
          TransientMediaError,
        );
      },
    );

    it('should classify a timeout as transient', async () => {
      execFile.mockRejectedValue(timeoutFailure());

      await expect(service.extractFrame(URL, 1)).rejects.toBeInstanceOf(
        TransientMediaError,
      );
    });

    it('should rethrow a maxBuffer overflow', async () => {
      const overflow = Object.assign(
        new Error('stdout maxBuffer length exceeded'),
        {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        },
      );
      execFile.mockRejectedValue(overflow);

      await expect(service.extractFrame(URL, 1)).rejects.toBe(overflow);
    });
  });
});
