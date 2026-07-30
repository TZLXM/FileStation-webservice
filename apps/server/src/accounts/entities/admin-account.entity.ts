import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('admin_accounts')
export class AdminAccount {
  @PrimaryColumn('text')
  id!: string;

  @Column({ unique: true })
  username!: string;

  @Column({ name: 'password_hash' })
  passwordHash!: string;

  @Column({ name: 'password_changed_at', type: 'integer' })
  passwordChangedAt!: number;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'is_active', default: 1 })
  isActive!: number;
}
