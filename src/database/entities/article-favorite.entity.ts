import { Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { Article } from './article.entity';
import { User } from './user.entity';

@Entity('article_favorites')
@Index('IDX_article_favorites_article_user', ['articleId', 'userId'])
export class ArticleFavorite {
  // The composite primary key is also the unique user/article constraint.
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @PrimaryColumn({ name: 'article_id', type: 'uuid' })
  articleId!: string;

  @ManyToOne(() => User, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn({
    name: 'user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'FK_article_favorites_user_id',
  })
  user!: User;

  @ManyToOne(() => Article, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn({
    name: 'article_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'FK_article_favorites_article_id',
  })
  article!: Article;
}
