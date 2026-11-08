export const VIDEO_TITLE_MAX_CODE_POINTS = 100;

// Cuts by Unicode code point, so a surrogate pair is never split in half.
export function truncateCodePoints(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}

function dropLastExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot === -1 ? filename : filename.slice(0, lastDot);
}

// Explicit title wins (trimmed; length is validated by the DTO). Otherwise
// the filename minus its last extension, falling back to the full filename
// when that leaves nothing (e.g. `.mp4`).
export function deriveVideoTitle(
  title: string | undefined,
  filename: string,
): string {
  if (title !== undefined) {
    return title.trim();
  }
  const withoutExtension = truncateCodePoints(
    dropLastExtension(filename).trim(),
    VIDEO_TITLE_MAX_CODE_POINTS,
  );
  if (withoutExtension.length > 0) {
    return withoutExtension;
  }
  return truncateCodePoints(filename.trim(), VIDEO_TITLE_MAX_CODE_POINTS);
}
