import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { UploadSession } from './upload-session.entity';

export enum UploadPartStatus {
  RECEIVING = 'receiving',
  READY = 'ready',
}

@Entity('upload_parts')
export class UploadPart {
  @PrimaryColumn({ name: 'upload_id' })
  uploadId!: string;

  @ManyToOne(() => UploadSession, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'upload_id' })
  upload!: UploadSession;

  @PrimaryColumn({ name: 'part_number' })
  partNumber!: number;

  @Column({ type: 'integer' })
  offset!: number;

  @Column({ type: 'integer' })
  size!: number;

  @Column()
  checksum!: string;

  // v1.6 新增：与迁移 upload_parts.status 对齐
  @Column({ type: 'text', default: UploadPartStatus.RECEIVING })
  status!: UploadPartStatus;

  // v1.6 新增：与迁移 upload_parts.owner_token 对齐（抢占所有者标识）
  @Column({ name: 'owner_token', type: 'text', nullable: true })
  ownerToken!: string | null;

  // v1.6 新增：与迁移 upload_parts.temp_name 对齐（临时文件名，ready 后为 null）
  @Column({ name: 'temp_name', type: 'text', nullable: true })
  tempName!: string | null;

  @Column({ name: 'received_at', type: 'integer' })
  receivedAt!: number;
}
