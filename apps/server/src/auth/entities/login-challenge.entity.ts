import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { AdminAccount } from '../../accounts/entities/admin-account.entity';

@Entity('login_challenges')
export class LoginChallenge {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'account_id' })
  accountId!: string;

  @ManyToOne(() => AdminAccount)
  @JoinColumn({ name: 'account_id' })
  account!: AdminAccount;

  @Column({ name: 'challenge_type' })
  challengeType!: 'totp' | 'webauthn';

  @Column({ name: 'challenge_data', type: 'text', nullable: true })
  challengeData!: string | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'expires_at', type: 'integer' })
  expiresAt!: number;

  @Column({ name: 'used_at', type: 'integer', nullable: true })
  usedAt!: number | null;
}
