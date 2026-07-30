import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { File } from './file.entity';

export enum UploadStatus {
  INITIATED = 'initiated',
  UPLOADING = 'uploading',
  VERIFYING = 'verifying',
  COMPLETED = 'completed',
  ABORTED = 'aborted',
  EXPIRED = 'expired',
  FAILED = 'failed',
}

@Entity('upload_sessions')
export class UploadSession {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'upload_token_hash', unique: true })
  uploadTokenHash!: string;

  @Column()
  filename!: string;

  @Column({ name: 'expected_size', type: 'integer' })
  expectedSize!: number;

  @Column({ name: 'expected_hash', nullable: true })
  expectedHash!: string | null;

  @Column({ name: 'chunk_size', type: 'integer' })
  chunkSize!: number;

  @Column({ default: UploadStatus.INITIATED })
  status!: UploadStatus;

  @Column({ name: 'received_size', default: 0 })
  receivedSize!: number;

  @Column({ name: 'final_stored_name', nullable: true })
  finalStoredName!: string | null;

  @Column({ name: 'final_file_id', nullable: true })
  finalFileId!: string | null;

  @ManyToOne(() => File, { nullable: true })
  @JoinColumn({ name: 'final_file_id' })
  finalFile!: File | null;

  @Column({ name: 'verify_started_at', type: 'integer', nullable: true })
  verifyStartedAt!: number | null;

  // v1.7 新增：finalizer 租约（阻断 4）
  @Column({ name: 'verify_owner_token', nullable: true })
  verifyOwnerToken!: string | null;

  @Column({ name: 'verify_lease_until', type: 'integer', nullable: true })
  verifyLeaseUntil!: number | null;

  @Column({ name: 'verify_heartbeat_at', type: 'integer', nullable: true })
  verifyHeartbeatAt!: number | null;

  // v1.7 新增：上传目标文件夹（建议 c）
  @Column({ name: 'target_folder_id', nullable: true })
  targetFolderId!: string | null;

  @Column({ name: 'failure_reason', nullable: true })
  failureReason!: string | null;

  @Column({ name: 'temp_path' })
  tempPath!: string;

  @Column({ name: 'principal_type' })
  principalType!: 'admin' | 'temp_code';

  @Column({ name: 'principal_id' })
  principalId!: string;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'expires_at', type: 'integer' })
  expiresAt!: number;

  @Column({ name: 'completed_at', type: 'integer', nullable: true })
  completedAt!: number | null;
}
