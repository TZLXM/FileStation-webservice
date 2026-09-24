import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('authenticators')
export class Authenticator {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'account_id' })
  accountId!: string;

  @Column()
  type!: 'totp' | 'webauthn';

  @Column()
  name!: string;

  @Column({ name: 'totp_secret_encrypted', type: 'text', nullable: true })
  totpSecretEncrypted!: string | null;

  @Column({ name: 'credential_id', type: 'text', nullable: true })
  credentialId!: string | null;

  @Column({ name: 'public_key', type: 'text', nullable: true })
  publicKey!: string | null;

  @Column({ name: 'sign_count', type: 'integer', default: 0 })
  signCount!: number;

  @Column({ type: 'text', nullable: true })
  transports!: string | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'last_used_at', type: 'integer', nullable: true })
  lastUsedAt!: number | null;

  @Column({ name: 'is_active', type: 'integer', default: 1 })
  isActive!: number;
}
