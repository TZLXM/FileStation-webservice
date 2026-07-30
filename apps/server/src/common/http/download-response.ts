import { Response } from 'express';

export interface DownloadHttpMeta {
  filename: string;
  mimeType: string | null;
  size: number;   // 文件总大小
  start: number;  // full 时为 0
  end: number;    // full 时为 size-1（空文件为 -1，不参与头部计算）
  isPartial: boolean;
}

export function writeDownloadHeaders(res: Response, meta: DownloadHttpMeta): void {
  res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
  // RFC 5987 filename*，避免引号注入与中文乱码
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store');

  if (meta.isPartial) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${meta.start}-${meta.end}/${meta.size}`);
    res.setHeader('Content-Length', meta.end - meta.start + 1);
  } else {
    res.setHeader('Content-Length', meta.size); // 空文件 = 0
  }
}
