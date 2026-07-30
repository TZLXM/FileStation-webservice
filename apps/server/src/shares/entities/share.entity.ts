import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { File } from '../../files/entities/file.entity';
import { AdminAccount } from '../../accounts/entities/admin-account.entity';

export enum ShareType {
  PAGE = 'page',
}

// v1.6 修正：与迁移 DB CHECK(protection IN ('none','password')) 对齐，Phase 1 移除 ADMIN
export enum ShareProtection {
  NONE = 'none',
  PASSWORD = 'password',
}

@Entity('shares')
export class Share {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'file_id' })
  fileId!: string;

  @ManyToOne(() => File, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'file_id' })
  file!: File;

  @Column({ type: 'text' })
  type!: ShareType;

  @Column({ type: 'text', default: ShareProtection.NONE })
  protection!: ShareProtection;

  @Column({ name: 'password_hash', type: 'text', nullable: true })
  passwordHash!: string | null;

  @Column({ name: 'max_downloads', type: 'integer', nullable: true })
  maxDownloads!: number | null;

  @Column({ name: 'used_downloads', default: 0 })
  usedDownloads!: number;

  @Column({ default: 'active' })
  status!: 'active' | 'revoked';

  @Column({ name: 'created_by' })
  createdBy!: string;

  @ManyToOne(() => AdminAccount)
  @JoinColumn({ name: 'created_by' })
  creator!: AdminAccount;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'expires_at', type: 'integer', nullable: true })
  expiresAt!: number | null;

  @Column({ name: 'revoked_at', type: 'integer', nullable: true })
  revokedAt!: number | null;

  @Column({ name: 'last_used_at', type: 'integer', nullable: true })
  lastUsedAt!: number | null;
}
