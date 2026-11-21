import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { I18nService } from 'nestjs-i18n';
import { DataSource, EntityManager, In, Not, QueryFailedError } from 'typeorm';
import { Article } from '../database/entities/article.entity';
import { ArticleTag } from '../database/entities/article-tag.entity';
import { ArticleFavorite } from '../database/entities/article-favorite.entity';
import { Follow } from '../database/entities/follow.entity';
import { Tag } from '../database/entities/tag.entity';
import { ARTICLE_TRANSACTION_MAX_ATTEMPTS } from './constants/article.constant';
import { CreateArticleDto, normalizeTag } from './dto/create-article.dto';
import { ArticleResponseDto } from './dto/article-response.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { mapArticle } from './mappers/article-response.mapper';
import { articleSlug } from './utils/article-slug.util';

function mysqlCode(error: unknown): string | undefined {
  return error instanceof QueryFailedError
    ? (error.driverError as { code?: string }).code
    : undefined;
}

function isSlugConflict(error: unknown): boolean {
  return (
    mysqlCode(error) === 'ER_DUP_ENTRY' &&
    error instanceof QueryFailedError &&
    /IDX_articles_slug_unique/.test(
      (error.driverError as { message?: string }).message ?? '',
    )
  );
}

@Injectable()
export class ArticlesService {
  private readonly logger = new Logger(ArticlesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly i18n: I18nService,
  ) {}

  async createArticle(
    dto: CreateArticleDto,
    authorId: string,
  ): Promise<ArticleResponseDto> {
    const slug = articleSlug(dto.title);
    const names = [...new Set((dto.tagList ?? []).map(normalizeTag))].sort();
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dataSource.transaction(
          'READ COMMITTED',
          async (manager) => {
            const id = randomUUID();
            try {
              await manager.insert(Article, {
                id,
                slug,
                title: dto.title,
                description: dto.description,
                body: dto.body,
                authorId,
              });
            } catch (error: unknown) {
              if (isSlugConflict(error)) {
                throw new ConflictException(
                  this.i18n.t('articles.SLUG_CONFLICT'),
                );
              }
              throw error;
            }

            if (names.length) {
              // A no-op duplicate update respects MySQL collation and concurrent
              // inserts without INSERT IGNORE hiding unrelated persistence errors.
              await manager.query(
                `INSERT INTO tags (id, name) VALUES ${names.map(() => '(?, ?)').join(', ')} ON DUPLICATE KEY UPDATE id = id`,
                names.flatMap((name) => [randomUUID(), name]),
              );
              const tags = await manager.find(Tag, {
                where: { name: In(names) },
                select: { id: true },
              });
              await manager.insert(
                ArticleTag,
                tags.map((tag) => ({ articleId: id, tagId: tag.id })),
              );
            }
            return this.loadArticle(manager, slug, authorId);
          },
        );
      } catch (error: unknown) {
        // MySQL rolls a deadlocked transaction back. Retry all work, boundedly.
        if (
          mysqlCode(error) === 'ER_LOCK_DEADLOCK' &&
          attempt < ARTICLE_TRANSACTION_MAX_ATTEMPTS
        )
          continue;
        this.handlePersistenceError(error);
      }
    }
  }

  async getArticle(
    slug: string,
    viewerId?: string,
  ): Promise<ArticleResponseDto> {
    try {
      return await this.loadArticle(this.dataSource.manager, slug, viewerId);
    } catch (error: unknown) {
      this.handlePersistenceError(error);
    }
  }

  async updateArticle(
    slug: string,
    dto: UpdateArticleDto,
    authorId: string,
  ): Promise<ArticleResponseDto> {
    return this.runMutation(async (manager) => {
      const article = await this.findOwnedArticle(manager, slug, authorId);
      const changes: Partial<
        Pick<Article, 'title' | 'description' | 'body' | 'slug'>
      > = {};
      if (dto.title !== undefined && dto.title !== article.title) {
        changes.title = dto.title;
        changes.slug = articleSlug(dto.title);
        if (
          changes.slug !== article.slug &&
          (await manager.existsBy(Article, {
            slug: changes.slug,
            id: Not(article.id),
          }))
        ) {
          throw new ConflictException(this.i18n.t('articles.SLUG_CONFLICT'));
        }
      }
      if (dto.description !== undefined) changes.description = dto.description;
      if (dto.body !== undefined) changes.body = dto.body;
      if (Object.keys(changes).length) {
        // Write only supplied fields, with stable identity and ownership scope.
        // The unique slug index still arbitrates races after the precheck.
        await manager.update(Article, { id: article.id, authorId }, changes);
      }
      return this.loadArticle(manager, changes.slug ?? article.slug, authorId);
    });
  }

  async deleteArticle(slug: string, authorId: string): Promise<void> {
    return this.runMutation(async (manager) => {
      const article = await this.findOwnedArticle(manager, slug, authorId);
      // Existing foreign keys cascade links/favorites; reusable tags survive.
      await manager.delete(Article, { id: article.id, authorId });
    });
  }

  private async findOwnedArticle(
    manager: EntityManager,
    slug: string,
    authorId: string,
  ): Promise<Pick<Article, 'id' | 'authorId' | 'title' | 'slug'>> {
    // A current locking read serializes update/delete of this resource and
    // keeps the ownership check valid until the transaction commits.
    const article = await manager.findOne(Article, {
      where: { slug },
      select: { id: true, authorId: true, title: true, slug: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!article)
      throw new NotFoundException(this.i18n.t('articles.NOT_FOUND'));
    if (article.authorId !== authorId) {
      throw new ForbiddenException(this.i18n.t('articles.NOT_AUTHOR'));
    }
    return article;
  }

  private async runMutation<T>(
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', operation);
      } catch (error: unknown) {
        if (
          mysqlCode(error) === 'ER_LOCK_DEADLOCK' &&
          attempt < ARTICLE_TRANSACTION_MAX_ATTEMPTS
        )
          continue;
        if (isSlugConflict(error)) {
          throw new ConflictException(this.i18n.t('articles.SLUG_CONFLICT'));
        }
        this.handlePersistenceError(error);
      }
    }
  }

  private async loadArticle(
    manager: EntityManager,
    slug: string,
    viewerId?: string,
  ): Promise<ArticleResponseDto> {
    const query = manager
      .createQueryBuilder(Article, 'article')
      .innerJoin('article.author', 'author')
      .select([
        'article.id',
        'article.slug',
        'article.title',
        'article.description',
        'article.body',
        'article.createdAt',
        'article.updatedAt',
        'author.username',
        'author.bio',
        'author.image',
      ])
      .addSelect(
        (sub) =>
          sub
            .select('COUNT(*)')
            .from(ArticleFavorite, 'favorite')
            .where('favorite.articleId = article.id'),
        'favoritesCount',
      )
      .where('article.slug = :slug', { slug });
    if (viewerId !== undefined) {
      query
        .addSelect(
          (sub) =>
            sub
              .select('COUNT(*)')
              .from(ArticleFavorite, 'mine')
              .where('mine.articleId = article.id AND mine.userId = :viewerId'),
          'favorited',
        )
        .addSelect(
          (sub) =>
            sub
              .select('COUNT(*)')
              .from(Follow, 'follow')
              .where(
                'follow.followingId = article.authorId AND follow.followerId = :viewerId',
              ),
          'following',
        )
        .setParameter('viewerId', viewerId);
    }
    const { entities, raw } = await query.getRawAndEntities<{
      favoritesCount: string;
      favorited?: string;
      following?: string;
    }>();
    const article = entities[0];
    if (!article)
      throw new NotFoundException(this.i18n.t('articles.NOT_FOUND'));
    const tags = await manager
      .createQueryBuilder(Tag, 'tag')
      .innerJoin(ArticleTag, 'link', 'link.tagId = tag.id')
      .select(['tag.name'])
      .where('link.articleId = :id', { id: article.id })
      .orderBy('tag.name', 'ASC')
      .getMany();
    return {
      article: mapArticle(article, {
        tagList: tags.map((tag) => tag.name),
        favoritesCount: Number(raw[0].favoritesCount),
        favorited: viewerId !== undefined && Number(raw[0].favorited) > 0,
        following: viewerId !== undefined && Number(raw[0].following) > 0,
      }),
    };
  }

  private handlePersistenceError(error: unknown): never {
    if (error instanceof QueryFailedError) {
      // Full cause stays server-side; SQL and driver details never reach clients.
      this.logger.error('Article persistence failed', error.stack);
      throw new InternalServerErrorException(
        this.i18n.t('articles.PERSISTENCE_FAILED'),
        { cause: error },
      );
    }
    throw error;
  }
}
