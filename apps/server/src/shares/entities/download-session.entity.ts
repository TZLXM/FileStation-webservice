import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Share } from './share.entity';
import { File } from '../../files/entities/file.entity';

@Entity('download_sessions')
export class DownloadSession {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'share_id' })
  shareId!: string;

  @ManyToOne(() => Share, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'share_id' })
  share!: Share;

  @Column({ name: 'file_id' })
  fileId!: string;

  @ManyToOne(() => File, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'file_id' })
  file!: File;

  @Column({ name: 'token_hash', unique: true })
  tokenHash!: string;

  @Column({ default: 0 })
  counted!: number;

  @Column({ name: 'counted_at', type: 'integer', nullable: true })
  countedAt!: number | null;

  @Column({ name: 'first_range_start', type: 'integer', nullable: true })
  firstRangeStart!: number | null;

  @Column({ name: 'last_range_end', type: 'integer', nullable: true })
  lastRangeEnd!: number | null;

  @Column({ name: 'total_bytes_sent', default: 0 })
  totalBytesSent!: number;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'expires_at', type: 'integer' })
  expiresAt!: number;
}
