import { Injectable, NotFoundException, GoneException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In, IsNull, DataSource } from 'typeorm';
import { File, FileStatus } from './entities/file.entity';
import { Folder } from '../folders/entities/folder.entity';
import { StorageService } from './storage.service';

@Injectable()
export class FilesService {
  constructor(
    @InjectRepository(File)
    private filesRepository: Repository<File>,
    @InjectRepository(Folder)
    private foldersRepository: Repository<Folder>,
    private storageService: StorageService,
    private dataSource: DataSource,
  ) {}

  /**
   * v1.7 建议 b：folder 过滤语义区分。
   * folderId === 'root' → 仅根目录（folder_id IS NULL）；
   * folderId === <uuid> → 指定文件夹；
   * folderId 缺省 → 所有文件。
   */
  async findAll(page: number = 1, pageSize: number = 20, folderId?: string): Promise<{ items: File[]; total: number }> {
    const where: any = { status: FileStatus.ACTIVE };
    if (folderId === 'root') {
      where.folderId = IsNull();
    } else if (folderId) {
      where.folderId = folderId;
    }
    const [items, total] = await this.filesRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total };
  }

  async findOne(id: string): Promise<File> {
    const file = await this.filesRepository.findOne({ where: { id } });
    if (!file) throw new NotFoundException('File not found');
    return file;
  }

  /** 管理员下载/读取前统一复验：存在且 status=active */
  async getActiveFile(id: string): Promise<File> {
    const file = await this.findOne(id);
    if (file.status !== FileStatus.ACTIVE) {
      throw new GoneException({ code: 'FILE_UNAVAILABLE', message: 'File is no longer available' });
    }
    return file;
  }

  /**
   * v1.7 阻断 6：folder_id 目标验证用单条 EXISTS 条件 UPDATE（原子守卫，防 delete 与 PATCH 同时成功）。
   * 仅 active/expired 可修改（防 PATCH 复活 deleting/deleted，v1.6 交叉审查）。
   */
  async update(id: string, updates: Partial<File>): Promise<File> {
    const file = await this.findOne(id);

    // 构建条件 UPDATE：folder_id 非 null 时用 EXISTS 守卫目标文件夹
    if (updates.folderId !== undefined && updates.folderId !== null && updates.folderId !== file.folderId) {
      const params: any[] = [updates.folderId, Date.now(), id, updates.folderId];
      // 其余字段也并入同一 UPDATE（避免两次写）
      const result: any = await this.dataSource.query(
        `UPDATE files SET folder_id = ?, updated_at = ?
         WHERE id = ? AND status IN ('active', 'expired')
           AND EXISTS (SELECT 1 FROM folders WHERE id = ? AND is_deleted = 0)`,
        params,
      );
      if ((result?.changes ?? result?.affected ?? 0) === 0) {
        // 区分：文件不可改 vs 目标文件夹不存在
        const target = await this.foldersRepository.findOne({ where: { id: updates.folderId, isDeleted: 0 } });
        if (!target) {
          throw new NotFoundException({ code: 'TARGET_FOLDER_NOT_FOUND', message: 'Target folder not found or deleted' });
        }
        throw new GoneException({ code: 'FILE_UNAVAILABLE', message: 'File is being deleted or already deleted' });
      }
      // folder_id 已更新；若还有其他字段，继续走通用路径
      const { folderId: _done, ...rest } = updates;
      if (Object.keys(rest).length === 0) return this.findOne(id);
      updates = rest;
    }

    const result = await this.filesRepository.update(
      { id, status: In([FileStatus.ACTIVE, FileStatus.EXPIRED]) },
      { ...updates, updatedAt: Date.now() },
    );
    if ((result.affected ?? 0) === 0) {
      throw new GoneException({ code: 'FILE_UNAVAILABLE', message: 'File is being deleted or already deleted' });
    }
    return this.findOne(id);
  }

  /** 设为永久保留（expires_at = null 显式清除，同时清 expiredAt 恢复 active） */
  async setPermanent(id: string): Promise<File> {
    const result = await this.filesRepository.update(
      { id, status: In([FileStatus.ACTIVE, FileStatus.EXPIRED]) },
      { expiresAt: null, expiredAt: null, status: FileStatus.ACTIVE, updatedAt: Date.now() },
    );
    if ((result.affected ?? 0) === 0) {
      throw new GoneException({ code: 'FILE_UNAVAILABLE', message: 'File is being deleted or already deleted' });
    }
    return this.findOne(id);
  }

  /** 仅置 deleting；磁盘删除与 deleted 终态由 FileLifecycleService.processDeletes() 消费 */
  async delete(id: string): Promise<void> {
    const result = await this.filesRepository.update(
      { id, status: Not(FileStatus.DELETED) },
      { status: FileStatus.DELETING, updatedAt: Date.now() },
    );
    if ((result.affected ?? 0) === 0) throw new NotFoundException('File not found');
  }

  /** v1.7 高优 7：条件 UPDATE（仅 active/expired 可续期），防复活 deleting/deleted */
  async extend(id: string, additionalHours: number): Promise<File> {
    const file = await this.findOne(id);
    const now = Date.now();
    const baseTime = file.expiresAt && file.expiresAt > now ? file.expiresAt : now;
    const newExpiresAt = baseTime + additionalHours * 60 * 60 * 1000;
    const result = await this.filesRepository.update(
      { id, status: In([FileStatus.ACTIVE, FileStatus.EXPIRED]) },
      {
        expiresAt: newExpiresAt,
        status: FileStatus.ACTIVE,
        expiredAt: null,
        updatedAt: now,
      },
    );
    if ((result.affected ?? 0) === 0) {
      throw new GoneException({ code: 'FILE_UNAVAILABLE', message: 'File is being deleted or already deleted' });
    }
    return this.findOne(id);
  }

  /** full（无 range）不传 start/end，避免空文件 createReadStream(start:0,end:-1) 报错 */
  async getFileStreamFor(file: File, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream> {
    return range
      ? this.storageService.getFileStream(file.storedName, range.start, range.end)
      : this.storageService.getFileStream(file.storedName);
  }
}
