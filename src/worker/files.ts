import type { Context } from 'hono';
import { ApiError } from './auth';
import type { AppEnv } from './types';

export interface FileRow {
  object_key: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
}

/** Call only after the route has authorized this specific attachment. */
export async function serveFile(c: Context<AppEnv>, row: FileRow) {
  const rangeHeader = c.req.header('Range');
  let range: { offset: number; length: number } | undefined;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || !row.size || (!match[1] && !match[2])) {
      c.header('Content-Range', `bytes */${row.size}`);
      return c.body(null, 416);
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, row.size - Number(match[2]));
    const end = match[1] ? (match[2] ? Math.min(Number(match[2]), row.size - 1) : row.size - 1) : row.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= row.size) {
      c.header('Content-Range', `bytes */${row.size}`);
      return c.body(null, 416);
    }
    if (!c.req.header('If-Range') || c.req.header('If-Range') === `"${row.sha256}"`) range = { offset: start, length: end - start + 1 };
  }
  const object = await c.env.FILES.get(row.object_key, range ? { range } : undefined);
  if (!object) throw new ApiError(503, 'FILE_MISSING', '附件暂时不可读取，请检查备份或重试。');
  const inline = /^(image\/(png|jpeg|gif|webp|avif)|audio\/(mpeg|ogg|wav|mp4)|video\/(mp4|webm))$/.test(row.mime);
  c.header('Content-Type', inline ? row.mime : 'application/octet-stream');
  c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/'/g, '%27')}`);
  // No conditional 304 responses: every request must pass authorization again.
  c.header('Cache-Control', 'private, no-store');
  c.header('Accept-Ranges', 'bytes');
  c.header('ETag', `"${row.sha256}"`);
  c.header('Content-Length', String(range?.length ?? row.size));
  if (range) c.header('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`);
  if (c.req.method === 'HEAD') return c.body(null, range ? 206 : 200);
  return c.body(object.body, range ? 206 : 200);
}
