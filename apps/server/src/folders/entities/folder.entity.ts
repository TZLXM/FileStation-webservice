import { Entity, PrimaryColumn, Column, Index, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { AdminAccount } from '../../accounts/entities/admin-account.entity';

@Entity('folders')
export class Folder {
  @PrimaryColumn('text')
  id!: string;

  @Column()
  name!: string;

  @Column({ name: 'parent_id', type: 'text', nullable: true })
  @Index('idx_folders_parent')
  parentId!: string | null;

  @ManyToOne(() => Folder, (folder) => folder.children, { nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent!: Folder | null;

  @OneToMany(() => Folder, (folder) => folder.parent)
  children!: Folder[];

  @Column({ name: 'created_by' })
  createdBy!: string;

  @ManyToOne(() => AdminAccount)
  @JoinColumn({ name: 'created_by' })
  creator!: AdminAccount;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'is_deleted', default: 0 })
  isDeleted!: number;

  @Column({ name: 'deleted_at', type: 'integer', nullable: true })
  deletedAt!: number | null;
}
