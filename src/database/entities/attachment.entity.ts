import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('attachments')
@Index('IDX_attachments_attachable_type_id', ['attachableType', 'attachableId'])
export class Attachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Stable resource discriminator, e.g. 'user' or 'article'. Ownership is
  // resolved by the resource service, rather than a fixed ORM relation.
  @Column({ name: 'attachable_type', type: 'varchar', length: 50 })
  attachableType!: string;

  @Column({ name: 'attachable_id', type: 'varchar', length: 36 })
  attachableId!: string;

  @Column({ type: 'varchar', length: 2048 })
  url!: string;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName!: string;

  @Column({ name: 'file_type', type: 'varchar', length: 127 })
  fileType!: string;

  // Decimal byte count. Keep BIGINT values as strings, never JavaScript numbers.
  @Column({ name: 'file_size', type: 'bigint', unsigned: true })
  fileSize!: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
