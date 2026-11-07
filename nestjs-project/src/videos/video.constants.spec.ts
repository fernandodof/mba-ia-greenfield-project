import {
  computePartCount,
  VIDEO_MAX_PART_COUNT,
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_PART_SIZE_BYTES,
} from './video.constants';

describe('video constants', () => {
  it('should define 64 MiB parts and a 10 GiB maximum', () => {
    expect(VIDEO_PART_SIZE_BYTES).toBe(67108864);
    expect(VIDEO_MAX_SIZE_BYTES).toBe(10737418240);
  });

  it('should keep the max part count consistent with the max size', () => {
    expect(computePartCount(VIDEO_MAX_SIZE_BYTES)).toBe(VIDEO_MAX_PART_COUNT);
  });
});

describe('computePartCount', () => {
  it.each([
    [1, 1],
    [67108864, 1],
    [67108865, 2],
    [10737418240, 160],
  ])('should split %d bytes into %d part(s)', (sizeBytes, expected) => {
    expect(computePartCount(sizeBytes)).toBe(expected);
  });
});
