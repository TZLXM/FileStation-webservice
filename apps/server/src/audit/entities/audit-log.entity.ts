import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'account_id', type: 'text', nullable: true })
  accountId!: string | null;

  @Column()
  action!: string;

  @Column({ name: 'resource_type', type: 'text', nullable: true })
  resourceType!: string | null;

  @Column({ name: 'resource_id', type: 'text', nullable: true })
  resourceId!: string | null;

  /** JSON string；禁止含密码/TOTP/完整 Token/恢复码明文 */
  @Column({ type: 'text', nullable: true })
  details!: string | null;

  @Column({ name: 'ip_address', type: 'text', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;
}
