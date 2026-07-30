import { Entity, PrimaryColumn, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { Folder } from '../../folders/entities/folder.entity';

export enum FileStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  DELETING = 'deleting',
  DELETED = 'deleted',
}

/**
 * File 生命周期状态机（全部由条件 UPDATE 驱动，SQLite 无 FOR UPDATE）：
 *
 *   active ──expires_at < now──────────────────────▶ expired   (FileLifecycleService.expireFiles)
 *   active ──管理员 DELETE /files/:id──────────────▶ deleting  (FilesService.delete，仅置状态)
 *   expired ──管理员续期（extend / PATCH expires_at)─▶ active   (expiredAt 清零，expiresAt 更新)
 *   expired ──expired_at 超过 cleanup_grace_hours──▶ deleting  (FileLifecycleService.queueDeletion)
 *   deleting ──磁盘删除成功────────────────────────▶ deleted   (FileLifecycleService.processDeletes，终态)
 *   deleting ──磁盘删除失败────────────────────────▶ deleting  (保留，下一周期/启动时重试)
 *
 * deleted 为终态：记录保留（审计、分享/下载计数一致性），磁盘文件已移除。
 * 约束：状态迁移只用条件 UPDATE（WHERE status=<前置状态>）；磁盘 I/O 永远在事务外。
 */
@Entity('files')
export class File {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'folder_id', nullable: true })
  @Index('idx_files_folder')
  folderId!: string | null;

  @ManyToOne(() => Folder, { nullable: true })
  @JoinColumn({ name: 'folder_id' })
  folder!: Folder | null;

  @Column()
  filename!: string;

  @Column({ name: 'stored_name', unique: true })
  storedName!: string;

  @Column({ type: 'integer' })
  size!: number;

  @Column({ name: 'mime_type', nullable: true })
  mimeType!: string | null;

  @Column({ name: 'hash_sha256', nullable: true })
  hashSha256!: string | null;

  @Column({ default: FileStatus.ACTIVE })
  @Index('idx_files_status_expires')
  status!: FileStatus;

  @Column({ name: 'expires_at', type: 'integer', nullable: true })
  expiresAt!: number | null;

  @Column({ name: 'expired_at', type: 'integer', nullable: true })
  expiredAt!: number | null;

  @Column({ name: 'deleted_at', type: 'integer', nullable: true })
  deletedAt!: number | null;

  @Column({ name: 'uploaded_by_type' })
  uploadedByType!: 'admin' | 'temp_code';

  @Column({ name: 'uploaded_by_id' })
  uploadedById!: string;

  @Column({ name: 'upload_ip', nullable: true })
  uploadIp!: string | null;

  @Column({ name: 'download_count', default: 0 })
  downloadCount!: number;

  @Column({ name: 'last_download_at', type: 'integer', nullable: true })
  lastDownloadAt!: number | null;

  @Column({ name: 'created_at', type: 'integer' })
  @Index('idx_files_created')
  createdAt!: number;

  @Column({ name: 'updated_at', type: 'integer' })
  updatedAt!: number;
}
