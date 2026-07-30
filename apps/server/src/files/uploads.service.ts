import { Injectable, BadRequestException, NotFoundException, ConflictException, GoneException } from '@nestjs/common';
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

@Injectable()
export class UploadsService {
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
  ) {}

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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query('BEGIN IMMEDIATE');

      // 会话状态原子守卫（防 complete 抢占后仍有分块写入）
      const sessionRows = await queryRunner.query(`SELECT status FROM upload_sessions WHERE id = ?`, [uploadId]);
      if (sessionRows.length === 0) throw new NotFoundException('Upload session not found');
      if (sessionRows[0].status !== UploadStatus.INITIATED && sessionRows[0].status !== UploadStatus.UPLOADING) {
        throw new BadRequestException({ code: 'INVALID_UPLOAD_STATE', message: `Operation not allowed in state: ${sessionRows[0].status}` });
      }

      const existing = await queryRunner.query(
        `SELECT status, checksum, owner_token FROM upload_parts WHERE upload_id = ? AND part_number = ?`,
        [uploadId, partNumber],
      );

      if (existing.length > 0 && existing[0].status === 'ready') {
        if (existing[0].checksum === info.checksum) {
          await queryRunner.query('COMMIT');
          return { outcome: 'already_ready' };
        }
        throw new ConflictException({
          code: 'PART_CHECKSUM_MISMATCH',
          message: 'Part already uploaded with different checksum',
          expected_checksum: existing[0].checksum,
          received_checksum: info.checksum,
        });
      }

      if (existing.length > 0 && existing[0].status === 'receiving') {
        if (existing[0].owner_token === info.ownerToken) {
          await queryRunner.query('COMMIT');
          return { outcome: 'claimed' }; // 同 owner 重试
        }
        throw new ConflictException({ code: 'PART_BEING_RECEIVED', message: 'Part is being received by another request; retry later' });
      }

      await queryRunner.query(
        `INSERT INTO upload_parts (upload_id, part_number, offset, size, checksum, status, owner_token, temp_name, received_at)
         VALUES (?, ?, ?, ?, ?, 'receiving', ?, ?, ?)`,
        [uploadId, partNumber, info.offset, info.size, info.checksum, info.ownerToken, info.tempName, info.now],
      );
      await queryRunner.query(`UPDATE upload_sessions SET status = 'uploading' WHERE id = ? AND status = 'initiated'`, [uploadId]);

      await queryRunner.query('COMMIT');
      return { outcome: 'claimed' };
    } catch (error) {
      await queryRunner.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async confirmPartReady(uploadId: string, partNumber: number, ownerToken: string, partSize: number): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query('BEGIN IMMEDIATE');
      const result: any = await queryRunner.query(
        `UPDATE upload_parts SET status = 'ready', owner_token = NULL, temp_name = NULL, received_at = ?
         WHERE upload_id = ? AND part_number = ? AND owner_token = ? AND status = 'receiving'`,
        [Date.now(), uploadId, partNumber, ownerToken],
      );
      const affected = result?.changes ?? result?.affected ?? 0;
      if (affected === 1) {
        await queryRunner.query(`UPDATE upload_sessions SET received_size = received_size + ? WHERE id = ?`, [partSize, uploadId]);
        await queryRunner.query('COMMIT');
        return;
      }
      await queryRunner.query('ROLLBACK');
      throw new ConflictException({ code: 'PART_CLAIM_LOST', message: 'Part claim expired while writing; re-upload this part' });
    } catch (error) {
      await queryRunner.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await queryRunner.release();
    }
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
   * 阶段二事务外：用持久化 final_stored_name 合并（.tmp + fsync + 原子 rename）+ 校验 + 刷新心跳。
   *   v1.7 阻断 2：阶段一提交后用 findOneByOrFail 重新加载实体（原生 SQL 不映射驼峰）。
   * 阶段三 BEGIN IMMEDIATE：INSERT files + UPDATE ... WHERE status='verifying' AND owner 匹配。
   *   v1.7 阻断 3：检查条件 UPDATE affected；0 时事务内重查（completed 同文件→幂等，否则回滚）。
   */
  async completeUpload(uploadId: string, uploadToken: string, finalHash?: string): Promise<{ file_id: string }> {
    const session = await this.validateUploadToken(uploadId, uploadToken);

    if (session.status === UploadStatus.COMPLETED) {
      return { file_id: session.finalFileId! };
    }

    // ---------- 阶段一：抢占 + 持久化 final_stored_name + 租约 ----------
    const preStoredName = this.storageService.generateStoredName();
    const ownerToken = uuidv4(); // finalizer 租约 owner
    const leaseMs = 10 * 60 * 1000; // 租约 10 分钟（远大于最长合并+哈希）

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query('BEGIN IMMEDIATE');
      const now = Date.now();
      const result: any = await queryRunner.query(
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
      const affected = result?.changes ?? result?.affected ?? 0;

      if (affected === 0) {
        const current = await queryRunner.query(`SELECT status, final_file_id FROM upload_sessions WHERE id = ?`, [uploadId]);
        if (current.length === 0) throw new NotFoundException('Upload session not found');
        if (current[0].status === 'completed') {
          await queryRunner.query('COMMIT');
          return { file_id: current[0].final_file_id };
        }
        if (current[0].status === 'verifying') {
          throw new ConflictException({ code: 'UPLOAD_FINALIZING', message: 'Another request is completing this upload' });
        }
        throw new BadRequestException({ code: 'INVALID_UPLOAD_STATE', message: `Cannot complete upload in state: ${current[0].status}` });
      }

      await queryRunner.query('COMMIT');
    } catch (error) {
      await queryRunner.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await queryRunner.release();
    }

    // v1.7 阻断 2：用 TypeORM 重新加载实体（原生 SQL 返回 snake_case，Repository.create 不映射驼峰）
    const claimedSession = await this.uploadsRepository.findOneByOrFail({ id: uploadId });

    // ---------- 阶段二：事务外合并与校验（.tmp + fsync + rename + 心跳刷新）----------
    const finalStoredName = claimedSession.finalStoredName!;
    try {
      const parts = await this.partsRepository.find({ where: { uploadId, status: UploadPartStatus.READY }, order: { partNumber: 'ASC' } });
      const totalParts = Math.ceil(claimedSession.expectedSize / claimedSession.chunkSize);
      if (parts.length !== totalParts) {
        throw new BadRequestException({ code: 'MISSING_PARTS', message: `Missing parts: expected ${totalParts}, got ${parts.length}` });
      }
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].partNumber !== i || parts[i].offset !== i * claimedSession.chunkSize) {
          throw new BadRequestException({ code: 'INVALID_PART_OFFSET', message: `Part ${i} has invalid offset` });
        }
      }

      // 合并到 .tmp 并 fsync + 原子 rename（v1.7 阻断 4：原子最终文件发布）
      // combineParts 内部：写 <stored_name>.tmp → fsync → rename → 刷新心跳（每分块/定时）
      await this.combinePartsWithHeartbeat(uploadId, totalParts, finalStoredName, ownerToken);

      // 校验最终哈希（优先请求 final_hash，其次初始化 expected_hash）；持久化实际计算值
      const actualHash = await this.storageService.calculateFileHash(this.storageService.getFinalPath(finalStoredName));
      const expectedHash = finalHash ?? claimedSession.expectedHash;
      if (expectedHash && actualHash !== expectedHash) {
        throw new BadRequestException({ code: 'FINAL_HASH_MISMATCH', message: 'Final file hash mismatch' });
      }

      // 阶段三前读默认过期设置（0 = 永久 null）
      const storageSettings = await this.settingsService.getStorageSettings();
      const fileExpiresAt = storageSettings.default_expire_hours > 0
        ? Date.now() + storageSettings.default_expire_hours * 60 * 60 * 1000
        : null;

      // ---------- 阶段三：INSERT files + 条件 UPDATE（带 owner 守卫 + affected 检查）----------
      const newFileId = uuidv4();
      const queryRunner3 = this.dataSource.createQueryRunner();
      await queryRunner3.connect();
      try {
        await queryRunner3.query('BEGIN IMMEDIATE');
        const now3 = Date.now();

        // 先 INSERT files（folder_id 来自 target_folder_id，v1.7 建议 c）
        await queryRunner3.query(
          `INSERT INTO files (id, folder_id, filename, stored_name, size, mime_type, hash_sha256,
             status, expires_at, uploaded_by_type, uploaded_by_id, download_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, ?, 0, ?, ?)`,
          [newFileId, claimedSession.targetFolderId, claimedSession.filename, finalStoredName,
           claimedSession.expectedSize, actualHash, fileExpiresAt, claimedSession.principalType, claimedSession.principalId, now3, now3],
        );

        // 条件 UPDATE：仅当仍 verifying 且 owner 匹配（租约未被接管）才完成；同时写回 final_file_id
        const updateResult: any = await queryRunner3.query(
          `UPDATE upload_sessions
             SET status = 'completed', completed_at = ?, failure_reason = NULL, final_file_id = ?,
                 verify_owner_token = NULL, verify_lease_until = NULL, verify_heartbeat_at = NULL
           WHERE id = ? AND status = 'verifying' AND verify_owner_token = ?`,
          [now3, newFileId, uploadId, ownerToken],
        );
        const updateAffected = updateResult?.changes ?? updateResult?.affected ?? 0;

        // v1.7 阻断 3：affected === 0 时事务内重查（completed 同文件→幂等，否则回滚）
        if (updateAffected === 0) {
          const current = await queryRunner3.query(
            `SELECT status, final_file_id FROM upload_sessions WHERE id = ?`,
            [uploadId],
          );
          if (current.length > 0 && current[0].status === 'completed' && current[0].final_file_id === newFileId) {
            // 已被本请求的前一次重试完成（幂等）——正常提交
            await queryRunner3.query('COMMIT');
            this.storageService.deleteUploadTempDir(uploadId).catch(() => {});
            return { file_id: newFileId };
          }
          // 失去完成权（租约被接管/状态被改）——回滚，新插入的 files 随之撤销
          throw new ConflictException({
            code: 'UPLOAD_FINALIZE_LOST',
            message: 'Lost finalize ownership (lease taken over or state changed)',
          });
        }

        await queryRunner3.query('COMMIT');
        this.storageService.deleteUploadTempDir(uploadId).catch(() => {});
        return { file_id: newFileId };
      } catch (error) {
        await queryRunner3.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await queryRunner3.release();
      }
    } catch (error: unknown) {
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
        await this.storageService.deleteFile(finalStoredName).catch(() => {});
        await this.dataSource.query(
          `UPDATE upload_sessions SET status = 'uploading', verify_started_at = NULL,
             verify_owner_token = NULL, verify_lease_until = NULL, verify_heartbeat_at = NULL
           WHERE id = ? AND status = 'verifying' AND verify_owner_token = ?`,
          [uploadId, ownerToken],
        );
      } else {
        // 不可恢复：标记 failed + 清租约（半成品由 FileLifecycleService 清理）
        await this.dataSource.query(
          `UPDATE upload_sessions SET status = 'failed', failure_reason = ?,
             verify_owner_token = NULL, verify_lease_until = NULL, verify_heartbeat_at = NULL
           WHERE id = ? AND status = 'verifying' AND verify_owner_token = ?`,
          [error instanceof Error ? error.message : 'Unknown error', uploadId, ownerToken],
        );
      }
      throw error;
    }
  }

  /**
   * 合并分块到 <stored_name>.tmp + fsync + 原子 rename 到正式路径（v1.7 阻断 4 原子发布）。
   * 合并期间用后台定时器刷新租约心跳（verify_heartbeat_at），防恢复任务误杀长合并。
   */
  private async combinePartsWithHeartbeat(
    uploadId: string,
    totalParts: number,
    storedName: string,
    ownerToken: string,
  ): Promise<void> {
    const tmpPath = this.storageService.getFinalPath(`${storedName}.tmp`);
    const finalPath = this.storageService.getFinalPath(storedName);

    // 后台心跳定时器：每 30s 刷新一次租约（合并期间保持 owner 所有权）
    const heartbeat = setInterval(() => {
      this.refreshVerifyHeartbeat(uploadId, ownerToken).catch(() => {});
    }, 30 * 1000);

    try {
      // 合并到 .tmp（StorageService.combineParts 内部流式 + fsync .tmp）
      await this.storageService.combineParts(uploadId, totalParts, tmpPath);
    } finally {
      clearInterval(heartbeat);
    }

    // fsync 已由 combineParts 完成；原子 rename 到正式路径
    const fs = await import('fs/promises');
    await fs.rename(tmpPath, finalPath);
  }

  /** 刷新 finalizer 租约心跳（仅当仍是 owner 且 verifying） */
  private async refreshVerifyHeartbeat(uploadId: string, ownerToken: string): Promise<void> {
    const now = Date.now();
    await this.dataSource.query(
      `UPDATE upload_sessions SET verify_heartbeat_at = ?, verify_lease_until = ?
       WHERE id = ? AND status = 'verifying' AND verify_owner_token = ?`,
      [now, now + 10 * 60 * 1000, uploadId, ownerToken],
    );
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
