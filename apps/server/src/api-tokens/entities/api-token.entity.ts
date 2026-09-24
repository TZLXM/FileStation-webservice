import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('api_tokens')
export class ApiToken {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'account_id' })
  accountId!: string;

  @Column()
  name!: string;

  @Column({ name: 'token_prefix' })
  tokenPrefix!: string;

  @Column({ name: 'token_hash' })
  tokenHash!: string;

  /** JSON string，元素为 ApiTokenScope */
  @Column({ type: 'text' })
  scopes!: string;

  @Column({ name: 'expires_at', type: 'integer', nullable: true })
  expiresAt!: number | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'last_used_at', type: 'integer', nullable: true })
  lastUsedAt!: number | null;

  @Column({ name: 'last_used_ip', type: 'text', nullable: true })
  lastUsedIp!: string | null;

  @Column({ name: 'revoked_at', type: 'integer', nullable: true })
  revokedAt!: number | null;
}
