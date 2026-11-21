import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TAG_NAME_MAX_LENGTH } from '../../articles/constants/article.constant';

@Entity('tags')
@Index('IDX_tags_name_unique', ['name'], { unique: true })
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: TAG_NAME_MAX_LENGTH })
  name!: string;
}
