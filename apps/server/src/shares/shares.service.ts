import { Injectable, NotFoundException, BadRequestException, GoneException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Share, ShareType, ShareProtection } from './entities/share.entity';
import { DownloadSession } from './entities/download-session.entity';
import { File, FileStatus } from '../files/entities/file.entity';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { ShareInfo } from '@filestation/shared';

@Injectable()
export class SharesService {
  constructor(
    @InjectRepository(Share)
    private sharesRepository: Repository<Share>,
    @InjectRepository(DownloadSession)
    private downloadSessionsRepository: Repository<DownloadSession>,
    @InjectRepository(File)
    private filesRepository: Repository<File>,
    private dataSource: DataSource,
  ) {}

  async createShare(
    fileId: string,
    type: ShareType,
    protection: ShareProtection,
    password: string | null,
    maxDownloads: number | null,
    expiresAt: Date | null,
    createdBy: string,
  ): Promise<Share> {
    const file = await this.filesRepository.findOne({ where: { id: fileId, status: FileStatus.ACTIVE } });
    if (!file) throw new NotFoundException('File not found');

    if (type !== ShareType.PAGE) {
      throw new BadRequestException({ code: 'INVALID_SHARE_TYPE', message: 'Only page shares are supported in Phase 1' });
    }

    // expires_at 不能是过去时间
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({ code: 'INVALID_EXPIRES_AT', message: 'expires_at must be in the future' });
    }

    const share = this.sharesRepository.create({
      id: this.generateShareId(),
      fileId,
      type,
      protection,
      passwordHash: password ? await bcrypt.hash(password, 10) : null,
      maxDownloads,
      usedDownloads: 0,
      status: 'active',
      createdBy,
      createdAt: Date.now(),
      expiresAt: expiresAt ? expiresAt.getTime() : null,
    });
    return this.sharesRepository.save(share);
  }

  async getShareInfo(shareId: string): Promise<ShareInfo> {
    const share = await this.sharesRepository.findOne({ where: { id: shareId }, relations: ['file'] });
    if (!share) throw new NotFoundException('Share not found');

    if (share.expiresAt && share.expiresAt < Date.now()) {
      throw new GoneException({ code: 'SHARE_EXPIRED', message: 'Share has expired' });
    }
    if (share.status === 'revoked') {
      throw new GoneException({ code: 'SHARE_REVOKED', message: 'Share has been revoked' });
    }
    if (share.maxDownloads !== null && share.usedDownloads >= share.maxDownloads) {
      throw new GoneException({ code: 'SHARE_EXHAUSTED', message: 'Share download limit reached' });
    }
    if (share.file.status !== FileStatus.ACTIVE) {
      throw new GoneException({ code: 'FILE_UNAVAILABLE', message: 'File is no longer available' });
    }

    return {
      id: share.id,
      file_id: share.fileId,
      filename: share.file.filename,
      size: share.file.size,
      type: share.type,
      protection: share.protection,
      requires_password: share.protection === ShareProtection.PASSWORD,
      expires_at: share.expiresAt ? new Date(share.expiresAt).toISOString() : null,
      max_downloads: share.maxDownloads,
      used_downloads: share.usedDownloads,
    };
  }

  /**
   * 统一 access 端点（v1.6：替代 createAccess/verifyPassword）。
   * protection=none 忽略 password 直接放行；protection=password 必须带 password 且校验。
   * 分享密码错误按 shareId 计数限流（5 错锁 10 分钟，防在线穷举）。
   */
  async accessShare(
    shareId: string,
    password?: string,
  ): Promise<{ download_token: string; expires_at: string; file_info: ShareInfo }> {
    // getShareInfo 统一校验：存在/未过期/未吊销/未耗尽/文件 active
    const shareInfo = await this.getShareInfo(shareId);

    if (shareInfo.protection === ShareProtection.PASSWORD) {
      if (!password) {
        throw new BadRequestException({ code: 'PASSWORD_REQUIRED', message: 'This share requires a password' });
      }
      // 限流检查（在凭证验证之前）
      await this.checkShareLockout(shareId);

      // v1.6：QueryBuilder addSelect 显式取 passwordHash（防 select:false 恒 undefined）
      const share = await this.sharesRepository
        .createQueryBuilder('share')
        .addSelect('share.passwordHash')
        .where('share.id = :shareId', { shareId })
        .getOne();
      if (!share || !share.passwordHash) {
        throw new BadRequestException({ code: 'INVALID_SHARE', message: 'Share password not set' });
      }
      const isValid = await bcrypt.compare(password, share.passwordHash);
      if (!isValid) {
        await this.recordShareFailure(shareId);
        throw new BadRequestException({ code: 'INVALID_PASSWORD', message: 'Invalid password' });
      }
      await this.clearShareFailures(shareId);
    }
    // protection === 'none'：忽略 body 中的 password，直接放行

    const downloadToken = uuidv4();
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 小时
    const session = this.downloadSessionsRepository.create({
      id: uuidv4(),
      shareId,
      fileId: shareInfo.file_id,
      tokenHash: this.hashToken(downloadToken),
      counted: 0,
      createdAt: Date.now(),
      expiresAt,
    });
    await this.downloadSessionsRepository.save(session);

    return {
      download_token: downloadToken,
      expires_at: new Date(expiresAt).toISOString(),
      file_info: shareInfo,
    };
  }

  /** 令牌 → 会话（仅解析与加载 file 关联；状态复验在 validateAuthorizedDownload） */
  async validateDownloadToken(token: string): Promise<DownloadSession> {
    const tokenHash = this.hashToken(token);
    const session = await this.downloadSessionsRepository.findOne({
      where: { tokenHash },
      relations: ['file'],
    });
    if (!session) {
      throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Download session not found' });
    }
    return session;
  }

  /**
   * 下载授权统一复验（/shares/:id/content 与 /downloads/:ticket 每次请求都必须调用）：
   *   0. session.shareId === 路由 shareId（防跨分享混用会话/票据）
   *   1. session 未过期
   *   2. share 未吊销（重新从 DB 加载）
   *   3. share 未过期
   *   4. file.status === 'active'
   * 不在此检查 max_downloads：额度扣减由 DownloadService.countDownload 的条件 UPDATE 原子保证。
   * 注：复验通过到 countDownload 事务提交之间存在 TOCTOU 窗口；最终防线是 countDownload
   * 事务内 `WHERE status='active'` 条件 UPDATE（防"吊销后仍计数"），前置复验是早期失败优化。
   */
  async validateAuthorizedDownload(shareId: string, session: DownloadSession): Promise<DownloadSession> {
    if (session.shareId !== shareId) {
      throw new ForbiddenException({ code: 'SESSION_SHARE_MISMATCH', message: 'Download session does not belong to this share' });
    }

    const now = Date.now();
    if (session.expiresAt <= now) {
      throw new GoneException({ code: 'TOKEN_EXPIRED', message: 'Download token has expired' });
    }

    const share = await this.sharesRepository.findOne({ where: { id: shareId }, relations: ['file'] });
    if (!share) {
      throw new NotFoundException({ code: 'SHARE_NOT_FOUND', message: 'Share not found' });
    }
    if (share.status !== 'active') {
      throw new GoneException({ code: 'SHARE_REVOKED', message: 'Share has been revoked' });
    }
    if (share.expiresAt !== null && share.expiresAt <= now) {
      throw new GoneException({ code: 'SHARE_EXPIRED', message: 'Share has expired' });
    }
    if (share.file.status !== FileStatus.ACTIVE) {
      throw new GoneException({ code: 'FILE_UNAVAILABLE', message: 'File is no longer available' });
    }

    // 以 DB 中最新 file 为准（覆盖调用方可能过期的 session.file）
    session.file = share.file;
    return session;
  }

  async findByFile(fileId: string): Promise<Share[]> {
    return this.sharesRepository.find({ where: { fileId }, order: { createdAt: 'DESC' } });
  }

  async revokeShare(shareId: string): Promise<void> {
    const result = await this.sharesRepository.update(
      { id: shareId, status: 'active' },
      { status: 'revoked', revokedAt: Date.now() },
    );
    if (result.affected === 0) {
      throw new NotFoundException('Share not found or already revoked');
    }
  }

  // ---- 分享密码限流（按 shareId，5 错锁 10 分钟，存 system_meta）----
  private async checkShareLockout(shareId: string): Promise<void> {
    const key = `share_lockout_${shareId}`;
    const rows = await this.dataSource.query(`SELECT value FROM system_meta WHERE key = ?`, [key]);
    if (rows.length === 0) return;
    const state = JSON.parse(rows[0].value);
    if (state.locked_until && state.locked_until > Date.now()) {
      const retryAfterSec = Math.ceil((state.locked_until - Date.now()) / 1000);
      throw new BadRequestException({ code: 'SHARE_LOCKED', message: `Too many failed attempts, retry after ${retryAfterSec} seconds`, retry_after: retryAfterSec });
    }
  }

  private async recordShareFailure(shareId: string): Promise<void> {
    const key = `share_lockout_${shareId}`;
    const rows = await this.dataSource.query(`SELECT value FROM system_meta WHERE key = ?`, [key]);
    const state = rows.length > 0 ? JSON.parse(rows[0].value) : { failed_count: 0, locked_until: null };
    state.failed_count += 1;
    if (state.failed_count >= 5) {
      state.locked_until = Date.now() + 10 * 60 * 1000; // 锁 10 分钟
      state.failed_count = 0;
    }
    await this.dataSource.query(
      `INSERT INTO system_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, JSON.stringify(state)],
    );
  }

  private async clearShareFailures(shareId: string): Promise<void> {
    await this.dataSource.query(`DELETE FROM system_meta WHERE key = ?`, [`share_lockout_${shareId}`]);
  }

  private generateShareId(): string {
    return randomBytes(16).toString('base64url'); // 128 bit
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
