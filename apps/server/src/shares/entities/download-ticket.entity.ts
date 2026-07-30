import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { DownloadSession } from './download-session.entity';

@Entity('download_tickets')
export class DownloadTicket {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'token_hash', unique: true })
  tokenHash!: string;

  @Column({ name: 'download_session_id' })
  downloadSessionId!: string;

  @ManyToOne(() => DownloadSession, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'download_session_id' })
  downloadSession!: DownloadSession;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'expires_at', type: 'integer' })
  expiresAt!: number;

  @Column({ name: 'revoked_at', type: 'integer', nullable: true })
  revokedAt!: number | null;
}
