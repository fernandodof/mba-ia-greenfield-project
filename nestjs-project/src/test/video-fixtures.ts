import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type TestVideoContainer = 'mp4' | 'mov' | 'mkv' | 'webm';

export interface TestVideoOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** File extension; ffmpeg picks the muxer from it. Default `mp4`. */
  container?: TestVideoContainer;
  /**
   * Adds a `comment` tag of this many ASCII bytes (via an ffmetadata file,
   * since one argv string is capped at 128 KiB on Linux). ffprobe echoes it
   * in `format.tags`, inflating its JSON output.
   */
  commentBytes?: number;
}

/** WebM only takes VP8/VP9/AV1; the others keep ffmpeg's default H.264. */
const CODEC_ARGS: Record<TestVideoContainer, string[]> = {
  mp4: [],
  mov: [],
  mkv: [],
  webm: ['-c:v', 'libvpx-vp9', '-b:v', '200k'],
};

/**
 * Generates a short video (lavfi test pattern, 10 fps; H.264 MP4 by
 * default) in the OS temp dir and returns its path; no binary fixtures are
 * committed. The caller deletes the file (`fs.rm(path, { force: true })`).
 */
export async function createTestVideo({
  durationSeconds = 2,
  width = 320,
  height = 240,
  container = 'mp4',
  commentBytes,
}: TestVideoOptions = {}): Promise<string> {
  const id = randomUUID();
  const path = join(tmpdir(), `streamtube-test-${id}.${container}`);
  const metadataPath = join(tmpdir(), `streamtube-test-${id}.ffmetadata`);
  const metadataArgs: string[] = [];
  if (commentBytes !== undefined) {
    await writeFile(
      metadataPath,
      `;FFMETADATA1\ncomment=${'x'.repeat(commentBytes)}\n`,
    );
    metadataArgs.push('-i', metadataPath, '-map', '0:v', '-map_metadata', '1');
  }
  try {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=10`,
      ...metadataArgs,
      '-pix_fmt',
      'yuv420p',
      ...CODEC_ARGS[container],
      '-y',
      path,
    ]);
  } finally {
    await rm(metadataPath, { force: true });
  }
  return path;
}
