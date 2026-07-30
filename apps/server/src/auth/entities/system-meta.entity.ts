import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('system_meta')
export class SystemMeta {
  @PrimaryColumn('text')
  key!: string;

  @Column('text')
  value!: string;
}
