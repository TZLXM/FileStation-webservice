import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Folder } from './entities/folder.entity';
import { File, FileStatus } from '../files/entities/file.entity';
import { v4 as uuidv4 } from 'uuid';
import { beginImmediate, safeRollback } from '../common/database/tx.helper';

@Injectable()
export class FoldersService {
  constructor(
    @InjectRepository(Folder)
    private foldersRepository: Repository<Folder>,
    @InjectRepository(File)
    private filesRepository: Repository<File>,
    private dataSource: DataSource,
  ) {}

  /** v1.7 阻断 6：目标文件夹验证纳入 BEGIN IMMEDIATE 写事务（防 delete 与 move 同时成功） */
  async create(name: string, parentId: string | null, createdBy: string): Promise<Folder> {
    if (!parentId) {
      const folder = this.foldersRepository.create({
        id: uuidv4(), name, parentId: null, createdBy, createdAt: Date.now(), isDeleted: 0,
      });
      return this.foldersRepository.save(folder);
    }

    // 写事务内重新验证目标存在未删除，再插入（防 findOne 后目标被并发软删）
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await beginImmediate(queryRunner);
      const parentRows = await queryRunner.query(
        `SELECT id FROM folders WHERE id = ? AND is_deleted = 0`, [parentId],
      );
      if (parentRows.length === 0) {
        throw new NotFoundException({ code: 'PARENT_FOLDER_NOT_FOUND', message: 'Parent folder not found or deleted' });
      }
      const id = uuidv4();
      await queryRunner.query(
        `INSERT INTO folders (id, name, parent_id, created_by, created_at, is_deleted) VALUES (?, ?, ?, ?, ?, 0)`,
        [id, name, parentId, createdBy, Date.now()],
      );
      await queryRunner.query('COMMIT');
      return this.findOne(id);
    } catch (error) {
      await safeRollback(queryRunner);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async findAll(): Promise<Folder[]> {
    return this.foldersRepository.find({ where: { isDeleted: 0 }, order: { name: 'ASC' } });
  }

  async findTree(): Promise<Folder[]> {
    const allFolders = await this.findAll();
    const folderMap = new Map<string, Folder & { children: Folder[] }>();
    const roots: (Folder & { children: Folder[] })[] = [];
    for (const folder of allFolders) {
      folderMap.set(folder.id, { ...folder, children: [] });
    }
    for (const folder of allFolders) {
      const node = folderMap.get(folder.id)!;
      if (folder.parentId && folderMap.has(folder.parentId)) {
        folderMap.get(folder.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async findOne(id: string): Promise<Folder> {
    const folder = await this.foldersRepository.findOne({ where: { id, isDeleted: 0 } });
    if (!folder) {
      throw new NotFoundException({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found' });
    }
    return folder;
  }

  async update(id: string, name: string): Promise<Folder> {
    const folder = await this.findOne(id);
    folder.name = name;
    return this.foldersRepository.save(folder);
  }

  /**
   * v1.7 阻断 6：BEGIN IMMEDIATE 写事务内循环重查 + 目标存在重查 + 条件 UPDATE。
   * 循环检查在取得写锁后重新执行（防并发移动造成环）；目标文件夹用单条 EXISTS 守卫。
   */
  async move(id: string, newParentId: string | null): Promise<Folder> {
    if (newParentId === id) {
      throw new BadRequestException({ code: 'MOVE_TO_SELF', message: 'Cannot move folder to itself' });
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await beginImmediate(queryRunner);

      // 本文件夹存在且未删除
      const selfRows = await queryRunner.query(`SELECT id FROM folders WHERE id = ? AND is_deleted = 0`, [id]);
      if (selfRows.length === 0) {
        throw new NotFoundException({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found or deleted' });
      }

      if (newParentId) {
        // 写事务内重查目标存在未删除
        const parentRows = await queryRunner.query(`SELECT id FROM folders WHERE id = ? AND is_deleted = 0`, [newParentId]);
        if (parentRows.length === 0) {
          throw new NotFoundException({ code: 'PARENT_FOLDER_NOT_FOUND', message: 'Target folder not found or deleted' });
        }
        // 写事务内循环重查（防并发移动造成环）
        const descendants = await this.getDescendantIdsInTransaction(queryRunner, id);
        if (descendants.includes(newParentId)) {
          throw new BadRequestException({ code: 'MOVE_TO_DESCENDANT', message: 'Cannot move folder to its descendant' });
        }
      }

      // 条件 UPDATE（双保险：仅当仍未删除时生效）
      await queryRunner.query(
        `UPDATE folders SET parent_id = ? WHERE id = ? AND is_deleted = 0`,
        [newParentId, id],
      );
      // node-sqlite3 不返回 UPDATE changes；事务内 SELECT 验证移动是否生效
      const moved = await queryRunner.query(
        `SELECT id FROM folders WHERE id = ? AND is_deleted = 0 AND parent_id IS NOT DISTINCT FROM ?`,
        [id, newParentId],
      );
      if (moved.length === 0) {
        throw new NotFoundException({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found or deleted' });
      }

      await queryRunner.query('COMMIT');
    } catch (error) {
      await safeRollback(queryRunner);
      throw error;
    } finally {
      await queryRunner.release();
    }

    return this.findOne(id);
  }

  /**
   * 原子删除：BEGIN IMMEDIATE 事务内重查子项计数，再条件软删。
   * 纯 SQL 事务（与 AuthService.initialize 同一模式），事务内无任何文件 I/O。
   */
  async delete(id: string): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await beginImmediate(queryRunner);

      // 事务内重查：文件夹存在且未删除
      const folderRows = await queryRunner.query(`SELECT id FROM folders WHERE id = ? AND is_deleted = 0`, [id]);
      if (folderRows.length === 0) {
        throw new NotFoundException({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found' });
      }

      // 事务内重查：子文件夹计数（BEGIN IMMEDIATE 持写锁，计数结果在事务内稳定）
      const childRows = await queryRunner.query(
        `SELECT COUNT(*) AS cnt FROM folders WHERE parent_id = ? AND is_deleted = 0`,
        [id],
      );
      if (Number(childRows[0].cnt) > 0) {
        throw new BadRequestException({ code: 'FOLDER_NOT_EMPTY', message: 'Cannot delete folder with subfolders' });
      }

      // 事务内重查：文件计数（所有非 deleted 状态）
      const fileRows = await queryRunner.query(
        `SELECT COUNT(*) AS cnt FROM files WHERE folder_id = ? AND status != ?`,
        [id, FileStatus.DELETED],
      );
      if (Number(fileRows[0].cnt) > 0) {
        throw new BadRequestException({ code: 'FOLDER_NOT_EMPTY', message: 'Cannot delete folder with files' });
      }

      // 条件软删（双保险：仅当仍未删除时生效）
      await queryRunner.query(
        `UPDATE folders SET is_deleted = 1, deleted_at = ? WHERE id = ? AND is_deleted = 0`,
        [Date.now(), id],
      );
      // node-sqlite3 不返回 UPDATE changes；事务内 SELECT 验证软删是否生效
      const deleted = await queryRunner.query(
        `SELECT id FROM folders WHERE id = ? AND is_deleted = 1`,
        [id],
      );
      if (deleted.length === 0) {
        throw new ConflictException({ code: 'FOLDER_ALREADY_DELETED', message: 'Folder was deleted concurrently' });
      }

      await queryRunner.query('COMMIT');
    } catch (error) {
      await safeRollback(queryRunner);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async getDescendantIds(folderId: string): Promise<string[]> {
    const result: string[] = [];
    const queue = [folderId];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = await this.foldersRepository.find({ where: { parentId: currentId, isDeleted: 0 } });
      for (const child of children) {
        result.push(child.id);
        queue.push(child.id);
      }
    }
    return result;
  }

  /** 事务内循环重查（move 用；BEGIN IMMEDIATE 持写锁，读取结果在事务内稳定） */
  private async getDescendantIdsInTransaction(queryRunner: any, folderId: string): Promise<string[]> {
    const result: string[] = [];
    const queue = [folderId];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = await queryRunner.query(
        `SELECT id FROM folders WHERE parent_id = ? AND is_deleted = 0`,
        [currentId],
      );
      for (const child of children) {
        result.push(child.id);
        queue.push(child.id);
      }
    }
    return result;
  }
}
