import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('recovery_codes')
export class RecoveryCode {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'account_id' })
  accountId!: string;

  @Column({ name: 'code_hash' })
  codeHash!: string;

  @Column({ name: 'used_at', type: 'integer', nullable: true })
  usedAt!: number | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'expires_at', type: 'integer' })
  expiresAt!: number;
}
