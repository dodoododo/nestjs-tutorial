import { Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { Article } from './article.entity';
import { Tag } from './tag.entity';

@Entity('article_tags')
@Index('IDX_article_tags_tag_article', ['tagId', 'articleId'])
export class ArticleTag {
  @PrimaryColumn({ name: 'article_id', type: 'uuid' })
  articleId!: string;

  @PrimaryColumn({ name: 'tag_id', type: 'uuid' })
  tagId!: string;

  @ManyToOne(() => Article, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn({
    name: 'article_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'FK_article_tags_article_id',
  })
  article!: Article;

  @ManyToOne(() => Tag, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn({
    name: 'tag_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'FK_article_tags_tag_id',
  })
  tag!: Tag;
}
