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

  @Column({ name: 'refresh_family_hash', type: 'text', nullable: true })
  refreshFamilyHash!: string | null;

  /** One bounded compatibility hash for a UUID cookie issued before token families. */
  @Column({ name: 'pre_family_refresh_token_hash', type: 'text', nullable: true })
  preFamilyRefreshTokenHash!: string | null;

  @Column({ name: 'device_info', type: 'text', nullable: true })
  deviceInfo!: string | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'expires_at', type: 'integer' })
  expiresAt!: number;

  @Column({ name: 'revoked_at', type: 'integer', nullable: true })
  revokedAt!: number | null;
}
