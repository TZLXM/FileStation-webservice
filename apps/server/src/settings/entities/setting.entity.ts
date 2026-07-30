import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { AdminAccount } from '../../accounts/entities/admin-account.entity';

@Entity('settings')
export class Setting {
  @PrimaryColumn('text')
  key!: string;

  @Column('text')
  value!: string;

  @Column({ name: 'updated_at', type: 'integer' })
  updatedAt!: number;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy!: string | null;

  @ManyToOne(() => AdminAccount, { nullable: true })
  @JoinColumn({ name: 'updated_by' })
  updater!: AdminAccount | null;
}
