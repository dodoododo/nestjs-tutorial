import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import {
  ARTICLE_DESCRIPTION_MAX_LENGTH,
  ARTICLE_SLUG_MAX_LENGTH,
  ARTICLE_TITLE_MAX_LENGTH,
} from '../../articles/constants/article.constant';
import { User } from './user.entity';

@Entity('articles')
@Index('IDX_articles_slug_unique', ['slug'], { unique: true })
@Index('IDX_articles_created_at_id', ['createdAt', 'id'])
@Index('IDX_articles_author_created_at_id', ['authorId', 'createdAt', 'id'])
export class Article {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: ARTICLE_SLUG_MAX_LENGTH })
  slug!: string;

  @Column({ type: 'varchar', length: ARTICLE_TITLE_MAX_LENGTH })
  title!: string;

  @Column({ type: 'varchar', length: ARTICLE_DESCRIPTION_MAX_LENGTH })
  description!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId!: string;

  @ManyToOne(() => User, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn({
    name: 'author_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'FK_articles_author_id',
  })
  author!: User;

  @CreateDateColumn({
    name: 'created_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt!: Date;
}
