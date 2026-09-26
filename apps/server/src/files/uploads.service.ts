import { Injectable, BadRequestException, NotFoundException, ConflictException, GoneException, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { UploadSession, UploadStatus } from './entities/upload-session.entity';
import { UploadPart, UploadPartStatus } from './entities/upload-part.entity';
import { File, FileStatus } from './entities/file.entity';
import { Folder } from '../folders/entities/folder.entity';
import { StorageService } from './storage.service';
import { SettingsService } from '../settings/settings.service';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { InitUploadDto } from './dto/init-upload.dto';
import { UploadInitResponse, UploadStatus as UploadStatusType } from '@filestation/shared';
import { SqliteImmediateTransactionService } from '../common/database/sqlite-immediate-transaction.service';
import { UploadVerifyHeartbeat, VerifyLeaseError } from './upload-verify-heartbeat';

const COMPLETION_MAX_WAIT_MS = 15 * 60 * 1000;
const COMPLETION_INITIAL_POLL_INTERVAL_MS = 100;
const COMPLETION_MAX_POLL_INTERVAL_MS = 1000;
const VERIFY_LEASE_MS = 10 * 60 * 1000;
const VERIFY_HEARTBEAT_INTERVAL_MS = 30 * 1000;

interface FinalizationObserver {
  controller: AbortController;
  promise: Promise<string>;
  waiters: number;
}

@Injectable()
export class UploadsService implements OnModuleDestroy {
  private readonly finalizationObservers = new Map<string, FinalizationObserver>();
  private readonly activeVerifyHeartbeats = new Set<UploadVerifyHeartbeat>();
  private verifyLeaseMs = VERIFY_LEASE_MS;
  private verifyHeartbeatIntervalMs = VERIFY_HEARTBEAT_INTERVAL_MS;

  constructor(
    @InjectRepository(UploadSession)
    private uploadsRepository: Repository<UploadSession>,
    @InjectRepository(UploadPart)
    private partsRepository: Repository<UploadPart>,
    @InjectRepository(File)
    private filesRepository: Repository<File>,
    @InjectRepository(Folder)
    private foldersRepository: Repository<Folder>,
    private storageService: StorageService,
    private settingsService: SettingsService,
    private dataSource: DataSource,
    private sqliteTransactions: SqliteImmediateTransactionService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    for (const observer of this.finalizationObservers.values()) observer.controller.abort();
    this.finalizationObservers.clear();
    const heartbeats = [...this.activeVerifyHeartbeats];
    for (const heartbeat of heartbeats) heartbeat.cancel();
    await Promise.all(heartbeats.map((heartbeat) => heartbeat.stop()));
    this.activeVerifyHeartbeats.clear();
  }

  async initializeUpload(
    dto: InitUploadDto,
    principalType: 'admin' | 'temp_code',
    principalId: string,
  ): Promise<UploadInitResponse> {
    // 目标文件夹验证（v1.6：上传可指定 folder_id）
    if (dto.folder_id) {
      const folder = await this.foldersRepository.findOne({ where: { id: dto.folder_id, isDeleted: 0 } });
      if (!folder) {
        throw new NotFoundException({ code: 'FOLDER_NOT_FOUND', message: 'Target folder not found or deleted' });
      }
    }

    const uploadId = uuidv4();
    const uploadToken = uuidv4();
    // v1.6：客户端未指定时用管理员配置的默认分块大小
    const transfer = await this.settingsService.getTransferSettings();
    const chunkSize = dto.chunk_size ?? transfer.default_chunk_size;
    const now = Date.now();

    await this.storageService.createUploadTempDir(uploadId);

    const session = this.uploadsRepository.create({
      id: uploadId,
      uploadTokenHash: this.hashToken(uploadToken),
      filename: dto.filename,
      expectedSize: dto.size,
      expectedHash: dto.hash ?? null,
      chunkSize,
      status: UploadStatus.INITIATED,
      receivedSize: 0,
      tempPath: this.storageService.getUploadTempDir(uploadId),
      principalType,
      principalId,
      targetFolderId: dto.folder_id ?? null, // v1.7 建议 c：持久化目标文件夹，阶段三直写 files.folder_id
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000, // 上传会话 24h
    });
    await this.uploadsRepository.save(session);

    return {
      upload_id: uploadId,
      upload_token: uploadToken,
      chunk_size: chunkSize,
      expires_at: new Date(session.expiresAt).toISOString(),
    };
  }

  /**
   * 上传分块：三阶段 owner 抢占协议。
   * 阶段一：BEGIN IMMEDIATE 抢占/幂等判定（无文件 I/O）
   * 阶段二：事务外写临时文件 -> fsync -> 校验 -> rename 到正式路径
   * 阶段三：BEGIN IMMEDIATE receiving -> ready + 首次递增 received_size
   */
  async uploadPart(
    uploadId: string,
    partNumber: number,
    data: Buffer,
    checksum: string,
    uploadToken: string,
  ): Promise<{ received: boolean; part_checksum: string }> {
    const session = await this.validateUploadToken(uploadId, uploadToken, [
      UploadStatus.INITIATED,
      UploadStatus.UPLOADING,
    ]);

    const totalParts = Math.ceil(session.expectedSize / session.chunkSize);
    if (!Number.isInteger(partNumber) || partNumber < 0 || partNumber >= totalParts) {
      throw new BadRequestException({
        code: 'INVALID_PART_NUMBER',
        message: `Part number must be between 0 and ${totalParts - 1}`,
      });
    }

    const expectedSize = partNumber === totalParts - 1
      ? session.expectedSize - partNumber * session.chunkSize
      : session.chunkSize;
    if (data.length !== expectedSize) {
      throw new BadRequestException({
        code: 'INVALID_PART_SIZE',
        message: `Part size must be ${expectedSize} bytes`,
        expected: expectedSize,
        actual: data.length,
      });
    }

    const ownerToken = uuidv4();
    const tempName = `${partNumber.toString().padStart(6, '0')}.${ownerToken}`;
    const offset = partNumber * session.chunkSize;

    // ---------- 阶段一：BEGIN IMMEDIATE 抢占（无文件 I/O）----------
    const claim = await this.claimPart(uploadId, partNumber, {
      offset, size: data.length, checksum, ownerToken, tempName, now: Date.now(),
    });

    if (claim.outcome === 'already_ready') {
      return { received: true, part_checksum: checksum }; // 幂等
    }

    // ---------- 阶段二：事务外文件 I/O ----------
    try {
      await this.storageService.writePartToTemp(uploadId, partNumber, ownerToken, data, checksum);
      await this.storageService.renamePart(uploadId, partNumber, ownerToken);
    } catch (error) {
      await this.storageService.deleteTempPart(uploadId, partNumber, ownerToken);
      if (error instanceof BadRequestException) {
        await this.releasePartClaim(uploadId, partNumber, ownerToken); // checksum 错误：释放接收权
      }
      // 其他 I/O 错误：保留 receiving 行，由 FileLifecycleService.recoverStaleReceivingParts 超时回收
      throw error;
    }

    // ---------- 阶段三：BEGIN IMMEDIATE receiving -> ready ----------
    await this.confirmPartReady(uploadId, partNumber, ownerToken, data.length);

    return { received: true, part_checksum: checksum };
  }

  private async claimPart(
    uploadId: string,
    partNumber: number,
    info: { offset: number; size: number; checksum: string; ownerToken: string; tempName: string; now: number },
  ): Promise<{ outcome: 'already_ready' | 'claimed' }> {
    return this.sqliteTransactions.run(async (connection) => {
      // 会话状态原子守卫（防 complete 抢占后仍有分块写入）
      const current = await connection.get<{ status: string }>(`SELECT status FROM upload_sessions WHERE id = ?`, [uploadId]);
      if (!current) throw new NotFoundException('Upload session not found');
      if (current.status !== UploadStatus.INITIATED && current.status !== UploadStatus.UPLOADING) {
        throw new BadRequestException({ code: 'INVALID_UPLOAD_STATE', message: `Operation not allowed in state: ${current.status}` });
      }

      const existing = await connection.get<{ status: string; checksum: string | null; owner_token: string | null }>(
        `SELECT status, checksum, owner_token FROM upload_parts WHERE upload_id = ? AND part_number = ?`,
        [uploadId, partNumber],
      );

      if (existing?.status === 'ready') {
        if (existing.checksum === info.checksum) {
          return { outcome: 'already_ready' };
        }
        throw new ConflictException({
          code: 'PART_CHECKSUM_MISMATCH',
          message: 'Part already uploaded with different checksum',
          expected_checksum: existing.checksum,
          received_checksum: info.checksum,
        });
      }

      if (existing?.status === 'receiving') {
        if (existing.owner_token === info.ownerToken) {
          return { outcome: 'claimed' }; // 同 owner 重试
        }
        throw new ConflictException({ code: 'PART_BEING_RECEIVED', message: 'Part is being received by another request; retry later' });
      }

      await connection.run(
        `INSERT INTO upload_parts (upload_id, part_number, offset, size, checksum, status, owner_token, temp_name, received_at)
         VALUES (?, ?, ?, ?, ?, 'receiving', ?, ?, ?)`,
        [uploadId, partNumber, info.offset, info.size, info.checksum, info.ownerToken, info.tempName, info.now],
      );
      await connection.run(`UPDATE upload_sessions SET status = 'uploading' WHERE id = ? AND status = 'initiated'`, [uploadId]);
      return { outcome: 'claimed' };
    });
  }

  private async confirmPartReady(uploadId: string, partNumber: number, ownerToken: string, partSize: number): Promise<void> {
    await this.sqliteTransactions.run(async (connection) => {
      const result = await connection.run(
        `UPDATE upload_parts SET status = 'ready', owner_token = NULL, temp_name = NULL, received_at = ?
         WHERE upload_id = ? AND part_number = ? AND owner_token = ? AND status = 'receiving'`,
        [Date.now(), uploadId, partNumber, ownerToken],
      );
      if (result.changes !== 1) {
        throw new ConflictException({ code: 'PART_CLAIM_LOST', message: 'Part claim expired while writing; re-upload this part' });
      }
      await connection.run(`UPDATE upload_sessions SET received_size = received_size + ? WHERE id = ?`, [partSize, uploadId]);
    });
  }

  private async releasePartClaim(uploadId: string, partNumber: number, ownerToken: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM upload_parts WHERE upload_id = ? AND part_number = ? AND owner_token = ? AND status = 'receiving'`,
      [uploadId, partNumber, ownerToken],
    );
  }

  async getUploadStatus(uploadId: string, uploadToken: string): Promise<UploadStatusType> {
    const session = await this.validateUploadToken(uploadId, uploadToken);
    const parts = await this.partsRepository.find({ where: { uploadId, status: UploadPartStatus.READY }, order: { partNumber: 'ASC' } });
    const totalParts = Math.ceil(session.expectedSize / session.chunkSize);
    return {
      id: session.id,
      status: session.status as UploadStatusType['status'],
      received_parts: parts.map((p) => p.partNumber),
      received_size: session.receivedSize,
      total_parts: totalParts,
      expected_size: session.expectedSize,
    };
  }

  /**
   * 完成上传：三阶段契约（v1.7 修正）。
   * 阶段一 BEGIN IMMEDIATE：条件 UPDATE 抢占，COALESCE 持久化 final_stored_name + 写入租约
   *   （verify_owner_token/verify_lease_until/verify_heartbeat_at）。
   *   v1.7 阻断 1：不再写 final_file_id（REFERENCES files(id) 外键，阶段三才创建文件）。
   * 阶段二事务外：用持久化 final_stored_name 合并到 owner 专属 staging、fsync、原子 rename 并校验；心跳持续到阶段三提交。
   *   v1.7 阻断 2：阶段一提交后用 findOneByOrFail 重新加载实体（原生 SQL 不映射驼峰）。
   * 阶段三 BEGIN IMMEDIATE：INSERT files + UPDATE ... WHERE status='verifying' AND owner 匹配。
   *   v1.7 阻断 3：检查条件 UPDATE affected；0 时事务内重查（completed 同文件→幂等，否则回滚）。
   */
  async completeUpload(
    uploadId: string,
    uploadToken: string,
    finalHash?: string,
    requestSignal?: AbortSignal,
  ): Promise<{ file_id: string; filename: string; size: number }> {
    const session = await this.validateUploadToken(uploadId, uploadToken);

    if (session.status === UploadStatus.COMPLETED) {
      return { file_id: session.finalFileId!, filename: session.filename, size: session.expectedSize };
    }

    let waitForFinalizer = false;

    // ---------- 阶段一：抢占 + 持久化 final_stored_name + 租约 ----------
    const preStoredName = this.storageService.generateStoredName();
    const ownerToken = uuidv4(); // finalizer 租约 owner
    const leaseMs = this.verifyLeaseMs;

    const claim = await this.sqliteTransactions.run(async (connection) => {
      const now = Date.now();
      const update = await connection.run(
        `UPDATE upload_sessions
           SET status = 'verifying',
               verify_started_at = ?,
               final_stored_name = COALESCE(final_stored_name, ?),
               verify_owner_token = ?,
               verify_lease_until = ?,
               verify_heartbeat_at = ?
         WHERE id = ? AND status IN ('initiated', 'uploading')`,
        [now, preStoredName, ownerToken, now + leaseMs, now, uploadId],
      );
      if (update.changes === 1) return { outcome: 'claimed' as const };

      const current = await connection.get<{ status: string; final_file_id: string | null }>(
        `SELECT status, final_file_id FROM upload_sessions WHERE id = ?`,
        [uploadId],
      );
      if (!current) throw new NotFoundException('Upload session not found');
      if (current.status === UploadStatus.COMPLETED) {
        if (!current.final_file_id) throw new Error('Completed upload is missing final_file_id');
        return { outcome: 'completed' as const, fileId: current.final_file_id };
      }
      if (current.status === UploadStatus.VERIFYING) {
        return { outcome: 'wait' as const };
      }
      throw new BadRequestException({ code: 'INVALID_UPLOAD_STATE', message: `Cannot complete upload in state: ${current.status}` });
    });

    if (claim.outcome === 'completed') {
      return { file_id: claim.fileId, filename: session.filename, size: session.expectedSize };
    }
    if (claim.outcome === 'wait') waitForFinalizer = true;

    if (waitForFinalizer) {
      return this.waitForFinalizedUpload(uploadId, session, requestSignal);
    }

    // v1.7 阻断 2：用 TypeORM 重新加载实体（原生 SQL 返回 snake_case，Repository.create 不映射驼峰）
    const claimedSession = await this.uploadsRepository.findOneByOrFail({ id: uploadId });

    // ---------- 阶段二：事务外合并与校验（owner staging + fsync + rename + 心跳刷新）----------
    const finalStoredName = claimedSession.finalStoredName!;
    const heartbeat = this.startVerifyHeartbeat(uploadId, ownerToken);
    try {
      heartbeat.assertOwned();
      const parts = await this.partsRepository.find({ where: { uploadId, status: UploadPartStatus.READY }, order: { partNumber: 'ASC' } });
      heartbeat.assertOwned();
      const totalParts = Math.ceil(claimedSession.expectedSize / claimedSession.chunkSize);
      if (parts.length !== totalParts) {
        throw new BadRequestException({ code: 'MISSING_PARTS', message: `Missing parts: expected ${totalParts}, got ${parts.length}` });
      }
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].partNumber !== i || parts[i].offset !== i * claimedSession.chunkSize) {
          throw new BadRequestException({ code: 'INVALID_PART_OFFSET', message: `Part ${i} has invalid offset` });
        }
      }

      // 合并到 owner 专属 staging 并 fsync + 原子 rename；owner 心跳覆盖合并、rename、hash、settings 和阶段三。
      await this.combinePartsWithHeartbeat(uploadId, totalParts, finalStoredName, ownerToken, heartbeat);

      // 校验最终哈希（优先请求 final_hash，其次初始化 expected_hash）；持久化实际计算值
      heartbeat.assertOwned();
      const actualHash = await this.storageService.calculateFileHash(this.storageService.getFinalPath(finalStoredName), heartbeat.signal);
      heartbeat.assertOwned();
      const expectedHash = finalHash ?? claimedSession.expectedHash;
      if (expectedHash && actualHash !== expectedHash) {
        throw new BadRequestException({ code: 'FINAL_HASH_MISMATCH', message: 'Final file hash mismatch' });
      }

      // 阶段三前读默认过期设置（0 = 永久 null）
      const storageSettings = await this.settingsService.getStorageSettings();
      await heartbeat.refreshNow();
      const fileExpiresAt = storageSettings.default_expire_hours > 0
        ? Date.now() + storageSettings.default_expire_hours * 60 * 60 * 1000
        : null;

      // ---------- 阶段三：INSERT files + 条件 UPDATE（带 owner 守卫 + affected 检查）----------
      const newFileId = uuidv4();
      heartbeat.assertOwned();
      const finalized = await this.sqliteTransactions.run(async (connection) => {
        const now3 = Date.now();

        // 先 INSERT files（folder_id 来自 target_folder_id，v1.7 建议 c）
        await connection.run(
          `INSERT INTO files (id, folder_id, filename, stored_name, size, mime_type, hash_sha256,
             status, expires_at, uploaded_by_type, uploaded_by_id, download_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, ?, 0, ?, ?)`,
          [newFileId, claimedSession.targetFolderId, claimedSession.filename, finalStoredName,
           claimedSession.expectedSize, actualHash, fileExpiresAt, claimedSession.principalType, claimedSession.principalId, now3, now3],
        );

        // 条件 UPDATE：仅当仍 verifying 且 owner 匹配（租约未被接管）才完成；同时写回 final_file_id
        const updateResult = await connection.run(
          `UPDATE upload_sessions
           SET status = 'completed', completed_at = ?, failure_reason = NULL, final_file_id = ?,
                 verify_owner_token = NULL, verify_lease_until = NULL, verify_heartbeat_at = NULL
           WHERE id = ? AND status = 'verifying' AND verify_owner_token = ? AND verify_lease_until > ?`,
          [now3, newFileId, uploadId, ownerToken, now3],
        );

        if (updateResult.changes === 1) {
          return { fileId: newFileId };
        }

        // owner 失效时在同一事务内重查；该 INSERT 随后回滚，避免留下孤儿 files 行。
        const current = await connection.get<{ status: string; final_file_id: string | null }>(
          `SELECT status, final_file_id FROM upload_sessions WHERE id = ?`,
          [uploadId],
        );
        if (current?.status === UploadStatus.COMPLETED && current.final_file_id === newFileId) {
          return { fileId: newFileId };
        }
        // 失去完成权（租约被接管/状态被改）——回滚，新插入的 files 随之撤销
        throw new ConflictException({
          code: 'UPLOAD_FINALIZE_LOST',
          message: 'Lost finalize ownership (lease taken over or state changed)',
        });
      });
      await this.stopVerifyHeartbeat(heartbeat);
      this.storageService.deleteUploadTempDir(uploadId).catch(() => {});
      return { file_id: finalized.fileId, filename: claimedSession.filename, size: claimedSession.expectedSize };
    } catch (error: unknown) {
      try {
        heartbeat.assertOwned();
      } catch (leaseError) {
        if (leaseError instanceof VerifyLeaseError && leaseError.reason === 'cancelled') {
          await this.releaseVerifyLease(uploadId, ownerToken);
          if (requestSignal?.aborted) throw this.createAbortError();
        }
        if (leaseError instanceof VerifyLeaseError && leaseError.reason === 'lost') {
          throw new ConflictException({
            code: 'UPLOAD_FINALIZE_LOST',
            message: 'Lost finalize ownership (lease taken over or state changed)',
          });
        }
        throw leaseError;
      }
      let errorCode: string | undefined;
      if (error instanceof BadRequestException) {
        const response = error.getResponse();
        if (typeof response === 'object' && response !== null && 'code' in response) {
          errorCode = String((response as any).code);
        }
      }
      const recoverable = ['MISSING_PARTS', 'FINAL_HASH_MISMATCH', 'INVALID_PART_OFFSET'];
      if (errorCode && recoverable.includes(errorCode)) {
        // 可恢复：删除半成品 + 回退 uploading + 清租约
        heartbeat.assertOwned();
        await this.storageService.deleteFile(finalStoredName).catch(() => {});
        await this.releaseVerifyLease(uploadId, ownerToken, 'uploading');
      } else {
        // 不可恢复：标记 failed + 清租约（半成品由 FileLifecycleService 清理）
        heartbeat.assertOwned();
        await this.sqliteTransactions.run((connection) => connection.run(
          `UPDATE upload_sessions SET status = 'failed', failure_reason = ?,
             verify_owner_token = NULL, verify_lease_until = NULL, verify_heartbeat_at = NULL
           WHERE id = ? AND status = 'verifying' AND verify_owner_token = ? AND verify_lease_until > ?`,
          [error instanceof Error ? error.message : 'Unknown error', uploadId, ownerToken, Date.now()],
        ));
      }
      throw error;
    } finally {
      await this.stopVerifyHeartbeat(heartbeat);
    }
  }

  /**
   * Same-session losers share one low-frequency observer per process. Their wait has a fixed
   * upper bound and is not extended by the owner's lease heartbeats.
   */
  private async waitForFinalizedUpload(
    uploadId: string,
    originalSession: UploadSession,
    requestSignal?: AbortSignal,
  ): Promise<{ file_id: string; filename: string; size: number }> {
    if (requestSignal?.aborted) throw this.createAbortError();

    let observer = this.finalizationObservers.get(uploadId);
    if (!observer) {
      const controller = new AbortController();
      const deadline = Date.now() + COMPLETION_MAX_WAIT_MS;
      const promise = this.observeFinalization(uploadId, controller.signal, deadline);
      observer = { controller, promise, waiters: 0 };
      // An individual request may disconnect before the shared observer reaches a terminal state.
      void promise.catch(() => {});
      this.finalizationObservers.set(uploadId, observer);
    }

    observer.waiters += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const leave = () => {
        observer!.waiters -= 1;
        if (observer!.waiters === 0 && this.finalizationObservers.get(uploadId) === observer) {
          this.finalizationObservers.delete(uploadId);
          observer!.controller.abort();
        }
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        requestSignal?.removeEventListener('abort', onAbort);
        leave();
        callback();
      };
      const onAbort = () => finish(() => reject(this.createAbortError()));

      requestSignal?.addEventListener('abort', onAbort, { once: true });
      observer!.promise.then(
        (fileId) => finish(() => resolve({ file_id: fileId, filename: originalSession.filename, size: originalSession.expectedSize })),
        (error: unknown) => finish(() => reject(error)),
      );
      if (requestSignal?.aborted) onAbort();
    });
  }

  private async observeFinalization(uploadId: string, signal: AbortSignal, deadline: number): Promise<string> {
    let intervalMs = COMPLETION_INITIAL_POLL_INTERVAL_MS;
    while (true) {
      if (signal.aborted) throw this.createAbortError();
      if (Date.now() >= deadline) {
        throw new ConflictException({ code: 'UPLOAD_FINALIZING', message: 'Another request is still completing this upload' });
      }

      const current = await this.uploadsRepository.findOneBy({ id: uploadId });
      if (!current) throw new NotFoundException('Upload session not found');
      if (current.status === UploadStatus.COMPLETED && current.finalFileId) return current.finalFileId;
      if (current.status !== UploadStatus.VERIFYING) {
        throw new BadRequestException({
          code: 'INVALID_UPLOAD_STATE',
          message: `Cannot complete upload in state: ${current.status}`,
          current: current.status,
        });
      }
      if (Date.now() >= deadline) {
        throw new ConflictException({ code: 'UPLOAD_FINALIZING', message: 'Another request is still completing this upload' });
      }

      await this.waitForObserverPoll(Math.min(intervalMs, deadline - Date.now()), signal);
      intervalMs = Math.min(intervalMs * 2, COMPLETION_MAX_POLL_INTERVAL_MS);
    }
  }

  private waitForObserverPoll(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(this.createAbortError());
        return;
      }
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(this.createAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private createAbortError(): Error {
    const error = new Error('Upload finalization wait was cancelled');
    error.name = 'AbortError';
    return error;
  }

  /**
   * 合并分块到 owner 专属 staging 文件 + fsync + 原子 rename 到正式路径。
   * 全流程 heartbeat 由 completeUpload 管理，此处在发布正式文件前同步确认 owner 仍有效。
   */
  private async combinePartsWithHeartbeat(
    uploadId: string,
    totalParts: number,
    storedName: string,
    ownerToken: string,
    heartbeat: UploadVerifyHeartbeat,
  ): Promise<void> {
    const tmpPath = this.storageService.getVerificationTempPath(storedName, ownerToken);
    const finalPath = this.storageService.getFinalPath(storedName);

    heartbeat.assertOwned();
    try {
      // StorageService 流式写入并 fsync owner 专属 staging 文件。
      await this.storageService.combineParts(uploadId, totalParts, tmpPath, heartbeat.signal);
      await heartbeat.refreshNow();
      heartbeat.assertOwned();

      // fsync 已由 combineParts 完成；发布前再次确认当前 owner。
      const fs = await import('fs/promises');
      await fs.rename(tmpPath, finalPath);
      heartbeat.assertOwned();
    } catch (error) {
      // staging 路径包含本 owner token；失权后只清理自己的未发布文件。
      const fs = await import('fs/promises');
      await fs.unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  /** 刷新 finalizer 租约心跳（仅当仍是 owner 且 verifying） */
  private async refreshVerifyHeartbeat(uploadId: string, ownerToken: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.sqliteTransactions.run((connection) => connection.run(
      `UPDATE upload_sessions SET verify_heartbeat_at = ?, verify_lease_until = ?
       WHERE id = ? AND status = 'verifying' AND verify_owner_token = ? AND verify_lease_until > ?`,
      [now, now + this.verifyLeaseMs, uploadId, ownerToken, now],
    ));
    return result.changes === 1;
  }

  private startVerifyHeartbeat(uploadId: string, ownerToken: string): UploadVerifyHeartbeat {
    const heartbeat = new UploadVerifyHeartbeat(
      this.verifyHeartbeatIntervalMs,
      () => this.refreshVerifyHeartbeat(uploadId, ownerToken),
    ).start();
    this.activeVerifyHeartbeats.add(heartbeat);
    return heartbeat;
  }

  private async stopVerifyHeartbeat(heartbeat: UploadVerifyHeartbeat): Promise<void> {
    await heartbeat.stop();
    this.activeVerifyHeartbeats.delete(heartbeat);
  }

  private async releaseVerifyLease(uploadId: string, ownerToken: string, status?: 'uploading'): Promise<void> {
    const targetStatus = status ? 'status = ?, verify_started_at = NULL,' : '';
    const parameters = status ? [status, uploadId, ownerToken] : [uploadId, ownerToken];
    await this.sqliteTransactions.run((connection) => connection.run(
      `UPDATE upload_sessions SET ${targetStatus}
         verify_owner_token = NULL, verify_lease_until = NULL, verify_heartbeat_at = NULL
       WHERE id = ? AND status = 'verifying' AND verify_owner_token = ?`,
      parameters,
    ));
  }

  async abortUpload(uploadId: string, uploadToken: string): Promise<void> {
    await this.validateUploadToken(uploadId, uploadToken, [UploadStatus.INITIATED, UploadStatus.UPLOADING]);
    await this.uploadsRepository.update(uploadId, { status: UploadStatus.ABORTED });
    await this.storageService.deleteUploadTempDir(uploadId);
  }

  async resumeUpload(uploadId: string, uploadToken: string): Promise<{ received_parts: number[]; chunk_size: number }> {
    const session = await this.validateUploadToken(uploadId, uploadToken, [UploadStatus.INITIATED, UploadStatus.UPLOADING]);
    const parts = await this.partsRepository.find({ where: { uploadId, status: UploadPartStatus.READY }, order: { partNumber: 'ASC' } });
    return { received_parts: parts.map((p) => p.partNumber), chunk_size: session.chunkSize };
  }

  private async validateUploadToken(uploadId: string, uploadToken: string, allowedStatuses?: UploadStatus[]): Promise<UploadSession> {
    const tokenHash = this.hashToken(uploadToken);
    const session = await this.uploadsRepository.findOne({ where: { id: uploadId, uploadTokenHash: tokenHash } });
    if (!session) throw new NotFoundException('Upload session not found');
    if (session.expiresAt < Date.now()) {
      throw new GoneException({ code: 'UPLOAD_EXPIRED', message: 'Upload session has expired' });
    }
    if (allowedStatuses && !allowedStatuses.includes(session.status)) {
      throw new BadRequestException({
        code: 'INVALID_UPLOAD_STATE',
        message: `Operation not allowed in state: ${session.status}`,
        allowed: allowedStatuses,
        current: session.status,
      });
    }
    return session;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
