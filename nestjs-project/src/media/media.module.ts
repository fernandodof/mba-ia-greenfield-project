import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Module } from '@nestjs/common';
import { FfmpegService } from './ffmpeg.service';
import { EXEC_FILE, type ExecFileFn } from './media.constants';

const execFileAsync = promisify(execFile);

const execFileBuffer: ExecFileFn = (file, args, options) =>
  execFileAsync(file, args, options);

@Module({
  providers: [{ provide: EXEC_FILE, useValue: execFileBuffer }, FfmpegService],
  exports: [FfmpegService],
})
export class MediaModule {}
