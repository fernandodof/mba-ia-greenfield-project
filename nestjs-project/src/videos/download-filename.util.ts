// Download name for `GET /videos/:slug/download` (TD-11 AMB-8 revision):
// sanitized title + the original file's extension, sent as an RFC 6266
// `Content-Disposition` with an ASCII `filename` and an RFC 5987 `filename*`.

const FALLBACK_NAME = 'video';
const VALID_EXTENSION = /^[a-z0-9]{1,10}$/;
// Control characters (Cc), invisible format characters (Cf: bidi controls
// such as U+202E RLO that can spoof the extension, zero-width characters,
// BOM) plus the characters most file systems reject.
const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}/\\:*?"<>|]/gu;
const NON_ASCII = /[^\x20-\x7E]/u;

function sanitizeTitle(title: string): string {
  const name = title
    .replace(FORBIDDEN_CHARACTERS, '')
    .replace(/\s+/g, ' ')
    .replace(/^ +/, '')
    .replace(/[ .]+$/, '');
  return name.length > 0 ? name : FALLBACK_NAME;
}

function extensionOf(originalFilename: string): string | undefined {
  const lastDot = originalFilename.lastIndexOf('.');
  if (lastDot === -1) return undefined;
  const extension = originalFilename.slice(lastDot + 1).toLowerCase();
  return VALID_EXTENSION.test(extension) ? extension : undefined;
}

// `encodeURIComponent` leaves `'()*` alone, but RFC 5987 `attr-char` excludes them.
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// One `_` per code point, so a surrogate pair becomes a single `_`.
function toAsciiFallback(value: string): string {
  return Array.from(value, (c) => (NON_ASCII.test(c) ? '_' : c)).join('');
}

export function buildDownloadContentDisposition(
  title: string,
  originalFilename: string,
): string {
  const extension = extensionOf(originalFilename);
  const base = sanitizeTitle(title);
  const name = extension === undefined ? base : `${base}.${extension}`;
  return `attachment; filename="${toAsciiFallback(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
