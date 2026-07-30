import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In, LessThan } from 'typeorm';
import { File, FileStatus } from './entities/file.entity';
import { UploadSession, UploadStatus } from './entities/upload-session.entity';
import { StorageService } from './storage.service';
import { SettingsService } from '../settings/settings.service';
import { promises as fs } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const RECEIVING_TIMEOUT_MS = 10 * 60 * 1000; // receiving 分块超 10 分钟（大于最长 64MB 写入预期）
const BATCH_SIZE = 100;

@Injectable()
export class FileLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FileLifecycleService.name);
  // 防 @Cron 重叠（上轮未跑完跳过本轮）；单语句条件 UPDATE 的方法无需 guard
  private processingDeletes = false;
  private recoveringVerifying = false;

  constructor(
    @InjectRepository(File)
    private filesRepository: Repository<File>,
    @InjectRepository(UploadSession)
    private uploadSessionsRepository: Repository<UploadSession>,
    private storageService: StorageService,
    private settingsService: SettingsService,
    private dataSource: DataSource,
  ) {}

  /**
   * 启动全量扫描：覆盖进程停机期间的过期文件/删除队列/过期上传/卡死 verifying/孤儿临时文件。
   * 在 app.listen() 前执行完毕（main.ts 阶段 3 app.init() 触发），无竞态窗口。
   * 注：@Cron 方法也有独立调度，若启动扫描耗时超过 1 分钟，cron 触发的那次会被 guard 静默跳过（可接受）。
   */
  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('Startup lifecycle scan...');
    try {
      await this.expireFiles();
      await this.processDeletes();
      await this.cleanupExpiredUploadSessions();
      await this.recoverVerifyingUploads();
      await this.scanOrphanTempFiles();
    } catch (err) {
      this.logger.error('Startup lifecycle scan failed', err instanceof Error ? err.stack : err);
    }
  }

  /** active 且 expires_at < now → expired（单语句条件 UPDATE；expires_at 为 NULL（永久）天然不匹配 "<"） */
  @Cron(CronExpression.EVERY_MINUTE)
  async expireFiles(): Promise<number> {
    const now = Date.now();
    const result = await this.filesRepository.update(
      { status: FileStatus.ACTIVE, expiresAt: LessThan(now) },
      { status: FileStatus.EXPIRED, expiredAt: now, updatedAt: now },
    );
    const n = result.affected ?? 0;
    if (n > 0) this.logger.log(`Expired ${n} file(s)`);
    return n;
  }

  /** expired 超过 cleanup_grace_hours → deleting（cleanup_grace_hours 消费方） */
  async queueDeletion(): Promise<number> {
    const { cleanup_grace_hours } = await this.settingsService.getStorageSettings();
    const graceMs = Math.max(0, cleanup_grace_hours) * 60 * 60 * 1000;
    const cutoff = Date.now() - graceMs;
    const now = Date.now();
    const result = await this.filesRepository.update(
      { status: FileStatus.EXPIRED, expiredAt: LessThan(cutoff) },
      { status: FileStatus.DELETING, updatedAt: now },
    );
    const n = result.affected ?? 0;
    if (n > 0) this.logger.log(`Queued ${n} expired file(s) for deletion`);
    return n;
  }

  /**
   * deleting → 删磁盘文件 → deleted。
   * 顺序约束：磁盘 I/O 在前（事务外），条件 UPDATE 落终态在后。
   * 崩溃安全：磁盘已删但 UPDATE 未执行 → 下轮重试，deleteFile 对 ENOENT 幂等。
   * 失败重试：磁盘删除抛错（非 ENOENT）→ 保持 deleting，下轮/启动时再试。
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async processDeletes(): Promise<void> {
    if (this.processingDeletes) return;
    this.processingDeletes = true;
    try {
      await this.queueDeletion(); // 同周期内先把到期 expired 转入 deleting
      const batch = await this.filesRepository.find({
        where: { status: FileStatus.DELETING },
        take: BATCH_SIZE,
      });
      for (const file of batch) {
        try {
          await this.storageService.deleteFile(file.storedName); // ENOENT 幂等
          const now = Date.now();
          const result = await this.filesRepository.update(
            { id: file.id, status: FileStatus.DELETING }, // 条件 UPDATE：期间被续期则跳过
            { status: FileStatus.DELETED, deletedAt: now, updatedAt: now },
          );
          if ((result.affected ?? 0) === 0) {
            this.logger.warn(`File ${file.id} left 'deleting' during processing, skipped`);
          }
        } catch (err) {
          this.logger.error(`Failed to delete file ${file.id} (${file.storedName}), will retry`, err instanceof Error ? err.stack : err);
        }
      }
    } finally {
      this.processingDeletes = false;
    }
  }

  /**
   * 过期 upload_sessions（initiated/uploading 且 expires_at < now）→ expired + 删临时目录。
   * 先条件 UPDATE 抢占（防与进行中的 uploadPart/completeUpload 竞态），再事务外删目录。
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async cleanupExpiredUploadSessions(): Promise<void> {
    const now = Date.now();
    const expiring = await this.uploadSessionsRepository.find({
      where: { status: In([UploadStatus.INITIATED, UploadStatus.UPLOADING]), expiresAt: LessThan(now) },
      take: BATCH_SIZE,
    });
    for (const session of expiring) {
      const result = await this.uploadSessionsRepository.update(
        { id: session.id, status: In([UploadStatus.INITIATED, UploadStatus.UPLOADING]) },
        { status: UploadStatus.EXPIRED },
      );
      if ((result.affected ?? 0) === 0) continue; // 已被并发 completeUpload 抢占
      await this.storageService.deleteUploadTempDir(session.id).catch((err) => {
        this.logger.warn(`Failed to remove temp dir for upload ${session.id}: ${err}`);
      });
    }
  }

  /**
   * verifying 租约过期恢复（v1.7 阻断 4：不再按固定 5 分钟误杀）。
   * 只接管租约已过期（verify_lease_until < now）的会话；正常合并期间 owner 每 30s 刷新心跳，
   * 因此长合并不会被误接管。接管流程：
   * 1. BEGIN IMMEDIATE 条件 UPDATE 抢占租约（旧 owner 若仍在写会心跳失败）。
   * 2. 事务外检查：正式文件存在且完整 → 继续阶段三；不存在但 ready 分块完整 → 重新合并；否则 → failed。
   * 3. 阶段三与 completeUpload 同构（INSERT files + 条件 UPDATE 带 owner 守卫 + affected 检查）。
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async recoverVerifyingUploads(): Promise<void> {
    if (this.recoveringVerifying) return;
    this.recoveringVerifying = true;
    try {
      const now = Date.now();
      // 只接管租约已过期的会话（v1.7：verify_lease_until < now；兼容无租约旧数据用 verify_started_at + 5min）
      const stuck = await this.dataSource.query(
        `SELECT * FROM upload_sessions
         WHERE status = 'verifying'
           AND (
             (verify_lease_until IS NOT NULL AND verify_lease_until < ?)
             OR (verify_lease_until IS NULL AND verify_started_at < ?)
           )`,
        [now, now - 5 * 60 * 1000],
      );
      for (const row of stuck) {
        const session = row as UploadSession;
        await this.recoverOneVerifying(session).catch((err) => {
          this.logger.error(`Failed to recover verifying upload ${session.id}`, err instanceof Error ? err.stack : err);
        });
      }
    } finally {
      this.recoveringVerifying = false;
    }
  }

  private async recoverOneVerifying(session: UploadSession): Promise<void> {
    const storedName = session.finalStoredName;
    if (!storedName) {
      // 无 final_stored_name（阶段一未持久化，异常）：防御性回退 uploading
      await this.uploadSessionsRepository.update(
        { id: session.id, status: UploadStatus.VERIFYING },
        { status: UploadStatus.UPLOADING, verifyStartedAt: null, verifyOwnerToken: null, verifyLeaseUntil: null, verifyHeartbeatAt: null },
      );
      return;
    }

    // ---- 1. BEGIN IMMEDIATE 抢占租约（接管 ownership）----
    const recoveryOwner = uuidv4();
    const now = Date.now();
    const claimResult: any = await this.dataSource.query(
      `UPDATE upload_sessions
         SET verify_owner_token = ?, verify_lease_until = ?, verify_heartbeat_at = ?
       WHERE id = ? AND status = 'verifying'
         AND (verify_lease_until IS NULL OR verify_lease_until < ?)`,
      [recoveryOwner, now + 10 * 60 * 1000, now, session.id, now],
    );
    if ((claimResult?.changes ?? claimResult?.affected ?? 0) === 0) {
      return; // 已被并发接管或 owner 刚刷新租约
    }

    try {
      // ---- 2. 事务外：判定能否完成 ----
      const stats = await this.storageService.getFileStats(storedName).catch(() => null);
      let canFinalize = stats && Number(stats.size) === session.expectedSize;
      let actualHash: string | null = null;
      if (canFinalize) {
        actualHash = await this.storageService.calculateFileHash(this.storageService.getFinalPath(storedName)).catch(() => null);
        if (session.expectedHash && actualHash !== session.expectedHash) canFinalize = false;
      }

      if (!canFinalize) {
        // 正式文件不存在/不完整：ready 分块完整则重新合并（v1.7 阻断 4）
        const totalParts = Math.ceil(session.expectedSize / session.chunkSize);
        const readyParts = await this.dataSource.query(
          `SELECT COUNT(*) AS cnt FROM upload_parts WHERE upload_id = ? AND status = 'ready'`,
          [session.id],
        );
        if (Number(readyParts[0].cnt) === totalParts) {
          await this.storageService.combineParts(session.id, totalParts, this.storageService.getFinalPath(`${storedName}.tmp`));
          const fs = await import('fs/promises');
          await fs.rename(this.storageService.getFinalPath(`${storedName}.tmp`), this.storageService.getFinalPath(storedName));
          actualHash = await this.storageService.calculateFileHash(this.storageService.getFinalPath(storedName)).catch(() => null);
          canFinalize = actualHash !== null && (!session.expectedHash || actualHash === session.expectedHash);
        }
      }

      if (canFinalize) {
        await this.finishVerifyingUpload(session, storedName, actualHash, recoveryOwner);
        return;
      }

      // ---- 3. 标记 failed（带 owner 守卫）----
      await this.dataSource.query(
        `UPDATE upload_sessions SET status = 'failed', failure_reason = 'verify recovery: final file unavailable',
           verify_owner_token = NULL, verify_lease_until = NULL, verify_heartbeat_at = NULL
         WHERE id = ? AND status = 'verifying' AND verify_owner_token = ?`,
        [session.id, recoveryOwner],
      );
      await this.storageService.deleteFile(storedName).catch(() => {});
      await this.storageService.deleteUploadTempDir(session.id).catch(() => {});
      this.logger.warn(`Marked stuck verifying upload ${session.id} as failed`);
    } catch (err) {
      // 恢复中出错：释放租约，下轮重试
      await this.dataSource.query(
        `UPDATE upload_sessions SET verify_owner_token = NULL, verify_lease_until = NULL, verify_heartbeat_at = NULL
         WHERE id = ? AND verify_owner_token = ?`,
        [session.id, recoveryOwner],
      ).catch(() => {});
      throw err;
    }
  }

  /**
   * 恢复任务执行的阶段三：与 completeUpload 阶段三完全同构（v1.7 阻断 3 affected 检查）。
   * BEGIN IMMEDIATE 内 INSERT files + 条件 UPDATE（带 owner 守卫）；affected=0 时重查幂等或回滚。
   */
  private async finishVerifyingUpload(session: UploadSession, storedName: string, actualHash: string | null, recoveryOwner: string): Promise<void> {
    const storageSettings = await this.settingsService.getStorageSettings();
    const fileExpiresAt = storageSettings.default_expire_hours > 0
      ? Date.now() + storageSettings.default_expire_hours * 60 * 60 * 1000
      : null;

    const newFileId = uuidv4();
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query('BEGIN IMMEDIATE');
      const now = Date.now();

      await queryRunner.query(
        `INSERT INTO files (id, folder_id, filename, stored_name, size, mime_type, hash_sha256,
           status, expires_at, uploaded_by_type, uploaded_by_id, download_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, ?, 0, ?, ?)`,
        [newFileId, session.targetFolderId, session.filename, storedName, session.expectedSize,
         actualHash ?? session.expectedHash ?? null, fileExpiresAt, session.principalType, session.principalId, now, now],
      );

      const updateResult: any = await queryRunner.query(
        `UPDATE upload_sessions SET status = 'completed', completed_at = ?, failure_reason = NULL, final_file_id = ?,
           verify_owner_token = NULL, verify_lease_until = NULL, verify_heartbeat_at = NULL
         WHERE id = ? AND status = 'verifying' AND verify_owner_token = ?`,
        [now, newFileId, session.id, recoveryOwner],
      );
      const updateAffected = updateResult?.changes ?? updateResult?.affected ?? 0;

      if (updateAffected === 0) {
        const current = await queryRunner.query(`SELECT status, final_file_id FROM upload_sessions WHERE id = ?`, [session.id]);
        if (current.length > 0 && current[0].status === 'completed' && current[0].final_file_id === newFileId) {
          await queryRunner.query('COMMIT');
          this.storageService.deleteUploadTempDir(session.id).catch(() => {});
          return;
        }
        throw new Error('UPLOAD_FINALIZE_LOST');
      }

      await queryRunner.query('COMMIT');
      this.logger.log(`Recovered verifying upload ${session.id} -> completed (file ${newFileId})`);
    } catch (error) {
      await queryRunner.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.storageService.deleteUploadTempDir(session.id).catch(() => {});
  }

  /**
   * 每分钟：回收超时 receiving 分块（owner 阶段二崩溃留下的行）。
   * 删除 receiving 行 + 对应 owner 临时文件；会话状态不变，客户端可重传该分块。
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async recoverStaleReceivingParts(): Promise<void> {
    const deadline = Date.now() - RECEIVING_TIMEOUT_MS;
    const stale = await this.dataSource.query(
      `SELECT upload_id, part_number, owner_token FROM upload_parts WHERE status = 'receiving' AND received_at < ?`,
      [deadline],
    );
    for (const part of stale) {
      // 单语句原子删除（条件重复守卫：若 owner 刚好完成 ready 转换，此 DELETE 不匹配）
      const result: any = await this.dataSource.query(
        `DELETE FROM upload_parts WHERE upload_id = ? AND part_number = ? AND status = 'receiving'
           AND owner_token = ? AND received_at < ?`,
        [part.upload_id, part.part_number, part.owner_token, deadline],
      );
      const affected = result?.changes ?? result?.affected ?? 0;
      if (affected === 1 && part.owner_token) {
        await this.storageService.deleteTempPart(part.upload_id, part.part_number, part.owner_token).catch(() => {});
      }
    }
  }

  /**
   * 启动孤儿临时文件扫描：
   * 1) temp/<upload_id>/ 目录但 upload_sessions 不存在 → 整目录删除
   * 2) 会话为 completed/aborted/expired/failed → 整目录删除
   * 3) 会话为 initiated/uploading/verifying → 只删 *.part.tmp（owner 临时文件），保留 part_*.part
   */
  async scanOrphanTempFiles(): Promise<void> {
    const tempRoot = this.storageService.getTempRoot();
    let entries: string[];
    try {
      entries = await fs.readdir(tempRoot);
    } catch {
      return; // temp 根目录不存在
    }

    for (const uploadId of entries) {
      const dir = join(tempRoot, uploadId);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const rows = await this.dataSource.query(`SELECT status FROM upload_sessions WHERE id = ?`, [uploadId]);
      if (rows.length === 0 || ['completed', 'aborted', 'expired', 'failed'].includes(rows[0].status)) {
        await this.storageService.deleteUploadTempDir(uploadId).catch(() => {});
        continue;
      }

      const files = await fs.readdir(dir).catch(() => [] as string[]);
      for (const name of files) {
        if (name.endsWith('.part.tmp')) {
          await fs.unlink(join(dir, name)).catch(() => {});
        }
      }
    }
  }
}
