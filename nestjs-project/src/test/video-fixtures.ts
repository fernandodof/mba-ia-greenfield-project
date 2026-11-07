import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TestVideoOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
}

/**
 * Generates a short H.264 MP4 (lavfi test pattern, 10 fps) in the OS temp
 * dir and returns its path; no binary fixtures are committed. The caller
 * deletes the file (`fs.rm(path, { force: true })`).
 */
export async function createTestVideo({
  durationSeconds = 2,
  width = 320,
  height = 240,
}: TestVideoOptions = {}): Promise<string> {
  const path = join(tmpdir(), `streamtube-test-${randomUUID()}.mp4`);
  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=10`,
    '-pix_fmt',
    'yuv420p',
    '-y',
    path,
  ]);
  return path;
}
