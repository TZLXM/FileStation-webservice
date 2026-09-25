import { Injectable, GoneException, NotFoundException } from '@nestjs/common';
import { DownloadSession } from './entities/download-session.entity';
import { StorageService } from '../files/storage.service';
import { File } from '../files/entities/file.entity';
import { parseRangeHeader } from '../common/http/range-parser';
import { RangeNotSatisfiableException } from '../common/http/range-not-satisfiable.exception';
import { SqliteImmediateTransactionService } from '../common/database/sqlite-immediate-transaction.service';

export interface DownloadResult {
  stream: NodeJS.ReadableStream;
  file: File;
  session: DownloadSession;
  start: number;
  end: number;
  totalSize: number;
  isPartial: boolean;
}

@Injectable()
export class DownloadService {
  constructor(
    private storageService: StorageService,
    private sqliteTransactions: SqliteImmediateTransactionService,
  ) {}

  /**
   * 前置条件：调用方已通过 SharesService.validateAuthorizedDownload 复验。
   * 顺序：Range 解析（失败 416，不计数）→ 计数抢占（条件 UPDATE，先于建流）→ 建流。
   */
  async prepareDownload(session: DownloadSession, rangeHeader?: string): Promise<DownloadResult> {
    const file = session.file;

    const parsed = parseRangeHeader(rangeHeader, file.size);
    if (parsed.status === 'invalid' || parsed.status === 'unsatisfiable') {
      throw new RangeNotSatisfiableException(file.size);
    }
    const isPartial = parsed.status === 'partial';
    const start = isPartial ? (parsed as any).start : 0;
    const end = isPartial ? (parsed as any).end : file.size - 1; // 空文件 full：start=0, end=-1，仅用于 Content-Length=0

    // 先抢占计数权（建流之前；计数顺序约束：先 download_sessions.counted，后 shares.used_downloads）
    await this.countDownload(session);

    // full 不传 start/end（空文件 createReadStream 安全）
    const stream = isPartial
      ? await this.storageService.getFileStream(file.storedName, start, end)
      : await this.storageService.getFileStream(file.storedName);

    return { stream, file, session, start, end, totalSize: file.size, isPartial };
  }

  /**
   * 原子计数（SQLite 无 FOR UPDATE，全程条件 UPDATE）：
   *   1. UPDATE download_sessions SET counted=1 WHERE id=? AND counted=0 AND expires_at>now
   *      affected=0 → 已计数，直接返回（同 session 的后续 Range 请求不重复计数）
   *   2. UPDATE shares SET used_downloads=used_downloads+1
   *      WHERE id=? AND status='active' AND (max_downloads IS NULL OR used_downloads<max_downloads)
   *      affected=0 → 回滚（share 已被吊销/用尽），抛 SHARE_EXHAUSTED
   * 事务内无任何文件 I/O。
   */
  /**
   * 原子计数（v1.7 高优 8 修正）：
   *   1. UPDATE download_sessions SET counted=1 WHERE id=? AND counted=0 AND expires_at>now
   *      affected=1 → 获得计数权，继续；
   *      affected=0 → 重查分支：不存在→404 / 已过期→410 / counted=1→已计数（复验 share 后放行）
   *   2. UPDATE shares SET used_downloads+1
   *      WHERE id=? AND status='active'
   *        AND (max_downloads IS NULL OR used_downloads<max_downloads)
   *        AND (expires_at IS NULL OR expires_at > now)   -- v1.7 补过期条件
   *      affected=0 → 回滚抛 SHARE_EXHAUSTED
   *   3. 已计数的后续 Range 请求也在事务内复验 share 仍 active 未过期（防"复验后吊销仍放流"）
   * 事务内无任何文件 I/O。
   */
  private async countDownload(session: DownloadSession): Promise<void> {
    await this.sqliteTransactions.run(async (connection) => {
      const now = Date.now();
      const sessionResult = await connection.run(
        `UPDATE download_sessions SET counted = 1, counted_at = ?
         WHERE id = ? AND counted = 0 AND expires_at > ?`,
        [now, session.id, now],
      );

      if (sessionResult.changes === 1) {
        // 获得计数权：扣减分享额度（v1.7 补 expires_at 条件）
        const shareResult = await connection.run(
          `UPDATE shares SET used_downloads = used_downloads + 1, last_used_at = ?
           WHERE id = ? AND status = 'active'
             AND (max_downloads IS NULL OR used_downloads < max_downloads)
             AND (expires_at IS NULL OR expires_at > ?)`,
          [now, session.shareId, now],
        );

        if (shareResult.changes === 0) {
          throw new GoneException({ code: 'SHARE_EXHAUSTED', message: 'Share download limit reached, expired, or revoked' });
        }
        return;
      }

      // affected === 0：重查分支（v1.7 语义区分）
      const current = await connection.get<{ expires_at: number }>(
        `SELECT expires_at FROM download_sessions WHERE id = ?`,
        [session.id],
      );
      if (!current) {
        throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Download session not found' });
      }
      if (current.expires_at <= now) {
        throw new GoneException({ code: 'TOKEN_EXPIRED', message: 'Download token has expired' });
      }
      // counted=1（已计数）：同一事务内复验 share 仍 active 未过期（防"复验后吊销仍放流"）
      const shareCheck = await connection.get<{ id: string }>(
        `SELECT id FROM shares WHERE id = ? AND status = 'active'
           AND (expires_at IS NULL OR expires_at > ?)`,
        [session.shareId, now],
      );
      if (!shareCheck) {
        throw new GoneException({ code: 'SHARE_REVOKED', message: 'Share has been revoked or expired' });
      }
    });
  }
}
