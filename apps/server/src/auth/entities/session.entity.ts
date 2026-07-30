import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { AdminAccount } from '../../accounts/entities/admin-account.entity';

@Entity('sessions')
export class Session {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'account_id' })
  accountId!: string;

  @ManyToOne(() => AdminAccount)
  @JoinColumn({ name: 'account_id' })
  account!: AdminAccount;

  @Column({ name: 'refresh_token_hash', unique: true })
  refreshTokenHash!: string;

  @Column({ name: 'device_info', type: 'text', nullable: true })
  deviceInfo!: string | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'expires_at', type: 'integer' })
  expiresAt!: number;

  @Column({ name: 'revoked_at', type: 'integer', nullable: true })
  revokedAt!: number | null;
}
