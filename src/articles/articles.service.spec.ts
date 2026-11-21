import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { DataSource, QueryFailedError } from 'typeorm';
import { Article } from '../database/entities/article.entity';
import { ArticleTag } from '../database/entities/article-tag.entity';
import { ArticlesService } from './articles.service';
import { ListArticlesQueryDto } from './dto/list-articles-query.dto';
import { User } from '../database/entities/user.entity';

describe('ArticlesService', () => {
  const loaded = {
    id: 'article-id',
    slug: 'title',
    title: 'Title',
    description: 'Description',
    body: 'Body',
    createdAt: new Date('2026-01-01Z'),
    updatedAt: new Date('2026-01-01Z'),
    author: { username: 'author', bio: null, image: null },
  };
  const dto = { title: 'Title', description: 'Description', body: 'Body' };
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    clone: jest.fn().mockReturnThis(),
    subQuery: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    getQuery: jest.fn().mockReturnValue('(SELECT 1)'),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    getCount: jest.fn(),
    getRawMany: jest.fn(),
    setParameter: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawAndEntities: jest.fn(),
    getMany: jest.fn(),
  };
  const manager = {
    insert: jest.fn(),
    query: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    existsBy: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => qb),
  };
  const transaction = jest.fn();
  const i18n = { t: (key: string) => key } as unknown as I18nService;
  const service = new ArticlesService(
    { manager, transaction } as unknown as DataSource,
    i18n,
  );
  const failure = (code: string, message = 'driver details') =>
    new QueryFailedError(
      'private SQL',
      [],
      Object.assign(new Error(message), { code }),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    manager.insert.mockResolvedValue({});
    manager.query.mockResolvedValue({});
    manager.find.mockResolvedValue([{ id: 'tag-id' }]);
    manager.findOne.mockResolvedValue({
      id: 'article-id',
      authorId: 'author',
      title: 'Title',
      slug: 'title',
    });
    manager.existsBy.mockResolvedValue(false);
    manager.update.mockResolvedValue({ affected: 1 });
    manager.delete.mockResolvedValue({ affected: 1 });
    qb.getRawAndEntities.mockResolvedValue({
      entities: [loaded],
      raw: [{ favoritesCount: '3', favorited: '1', following: '1' }],
    });
    qb.getMany.mockResolvedValue([{ name: 'nestjs' }]);
    qb.getCount.mockResolvedValue(3);
    qb.getRawMany.mockResolvedValue([{ articleId: loaded.id, name: 'nestjs' }]);
    transaction.mockImplementation(
      (_isolation, callback: (manager: unknown) => unknown) =>
        callback(manager),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('listArticles', () => {
    it('maps a batch by stable IDs, omits body and selects only public columns', async () => {
      qb.getRawAndEntities.mockResolvedValueOnce({
        entities: [loaded, { ...loaded, id: 'second', slug: 'second' }],
        raw: [
          {
            article_id: 'second',
            favoritesCount: '0',
            favorited: '0',
            following: '0',
          },
          {
            article_id: loaded.id,
            favoritesCount: '3',
            favorited: '1',
            following: '1',
          },
        ],
      });
      const result = await service.listArticles(
        new ListArticlesQueryDto(),
        'viewer',
      );
      expect(result.articlesCount).toBe(3);
      expect(result.articles).toHaveLength(2);
      expect(result.articles[0]).toMatchObject({
        tagList: ['nestjs'],
        favoritesCount: 3,
        favorited: true,
        author: { following: true },
      });
      expect(result.articles[1]).toMatchObject({
        tagList: [],
        favoritesCount: 0,
        favorited: false,
        author: { following: false },
      });
      expect(result.articles[0]).not.toHaveProperty('body');
      const projection = qb.select.mock.calls.find(([columns]) =>
        Array.isArray(columns),
      )![0] as string[];
      expect(projection).not.toContain('article.body');
      expect(projection).not.toContain('author.email');
      expect(qb.limit).toHaveBeenCalledWith(20);
      expect(qb.offset).toHaveBeenCalledWith(0);
      expect(qb.orderBy).toHaveBeenCalledWith('article.createdAt', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('article.id', 'DESC');
      expect(qb.getCount).toHaveBeenCalledTimes(1);
      expect(qb.getRawAndEntities).toHaveBeenCalledTimes(1);
      expect(qb.getRawMany).toHaveBeenCalledTimes(1);
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('forces anonymous metadata false even if raw data contains flags', async () => {
      qb.getRawAndEntities.mockResolvedValueOnce({
        entities: [loaded],
        raw: [
          {
            article_id: loaded.id,
            favoritesCount: '3',
            favorited: '1',
            following: '1',
          },
        ],
      });
      const result = await service.listArticles(new ListArticlesQueryDto());
      expect(result.articles[0]).toMatchObject({
        favoritesCount: 3,
        favorited: false,
        author: { following: false },
      });
      expect(qb.setParameter).not.toHaveBeenCalled();
    });

    it.each(['author', 'favorited'] as const)(
      'explicitly returns an empty result for an unknown %s',
      async (field) => {
        manager.findOne.mockResolvedValueOnce(null);
        await expect(
          service.listArticles(
            Object.assign(new ListArticlesQueryDto(), { [field]: 'missing' }),
          ),
        ).resolves.toEqual({ articles: [], articlesCount: 0 });
        expect(manager.findOne).toHaveBeenCalledWith(User, {
          where: { username: 'missing' },
          select: { id: true },
        });
        expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      },
    );

    it.each([0, 3])(
      'retains the total %i on an empty or out-of-range page',
      async (count) => {
        qb.getCount.mockResolvedValueOnce(count);
        await expect(
          service.listArticles(
            Object.assign(new ListArticlesQueryDto(), { offset: 10 }),
          ),
        ).resolves.toEqual({ articles: [], articlesCount: count });
        expect(qb.getRawAndEntities).not.toHaveBeenCalled();
        expect(qb.getRawMany).not.toHaveBeenCalled();
      },
    );

    it('keeps filters parameterized and separate from the authenticated viewer', async () => {
      manager.findOne
        .mockResolvedValueOnce({ id: 'author-id' })
        .mockResolvedValueOnce({ id: 'favorites-user' });
      qb.getRawAndEntities.mockResolvedValueOnce({ entities: [], raw: [] });
      await service.listArticles(
        Object.assign(new ListArticlesQueryDto(), {
          author: 'Author',
          favorited: 'Alice',
          tag: "tag' OR 1=1",
          limit: 1,
          offset: 2,
        }),
        'viewer-id',
      );
      expect(qb.andWhere).toHaveBeenCalledWith('article.authorId = :authorId', {
        authorId: 'author-id',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('EXISTS (SELECT 1)', {
        tag: "tag' OR 1=1",
      });
      expect(qb.andWhere).toHaveBeenCalledWith('EXISTS (SELECT 1)', {
        favoritedById: 'favorites-user',
      });
      expect(qb.setParameter).toHaveBeenCalledWith('viewerId', 'viewer-id');
      expect(qb.limit).toHaveBeenCalledWith(1);
      expect(qb.offset).toHaveBeenCalledWith(2);
      expect(qb.getRawMany).not.toHaveBeenCalled();
    });

    it('sanitizes list persistence errors using the existing localized error', async () => {
      const cause = failure('ER_BAD_FIELD_ERROR');
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      qb.getCount.mockRejectedValueOnce(cause);
      await expect(
        service.listArticles(new ListArticlesQueryDto()),
      ).rejects.toMatchObject({
        status: 500,
        message: 'articles.PERSISTENCE_FAILED',
        cause,
      });
    });
  });

  it('uses the transaction manager for every write/read and deduplicates normalized tags', async () => {
    const result = await service.createArticle(
      { ...dto, tagList: [' NestJS ', 'NESTJS'] },
      'principal-id',
    );
    expect(transaction).toHaveBeenCalledWith(
      'READ COMMITTED',
      expect.any(Function),
    );
    expect(manager.insert).toHaveBeenNthCalledWith(
      1,
      Article,
      expect.objectContaining({ authorId: 'principal-id', slug: 'title' }),
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('ON DUPLICATE KEY UPDATE id = id'),
      [expect.any(String), 'nestjs'],
    );
    expect(manager.insert).toHaveBeenNthCalledWith(2, ArticleTag, [
      { articleId: expect.any(String), tagId: 'tag-id' },
    ]);
    expect(result.article).toMatchObject({
      favoritesCount: 3,
      favorited: true,
      author: { following: true },
    });
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(2);
  });

  it('does not write tags when the list is omitted', async () => {
    await service.createArticle(dto, 'principal-id');
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.insert).toHaveBeenCalledTimes(1);
  });

  it('turns only the article slug unique violation into a deliberate conflict', async () => {
    manager.insert.mockRejectedValueOnce(
      failure(
        'ER_DUP_ENTRY',
        "Duplicate entry for key 'articles.IDX_articles_slug_unique'",
      ),
    );
    await expect(service.createArticle(dto, 'author')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('retries the whole transaction after deadlock', async () => {
    manager.insert.mockRejectedValueOnce(failure('ER_LOCK_DEADLOCK'));
    await expect(service.createArticle(dto, 'author')).resolves.toHaveProperty(
      'article.slug',
      'title',
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it.each(['ER_LOCK_DEADLOCK', 'ER_DUP_ENTRY', 'ER_NO_REFERENCED_ROW_2'])(
    'bounds retries and sanitizes unexpected database failures: %s',
    async (code) => {
      const cause = failure(code);
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      manager.insert.mockRejectedValue(cause);
      await expect(service.createArticle(dto, 'author')).rejects.toMatchObject({
        status: 500,
        message: 'articles.PERSISTENCE_FAILED',
        cause,
      });
      expect(transaction).toHaveBeenCalledTimes(
        code === 'ER_LOCK_DEADLOCK' ? 3 : 1,
      );
      expect(log).toHaveBeenCalledWith(
        'Article persistence failed',
        cause.stack,
      );
    },
  );

  it('preserves non-database exceptions', async () => {
    const cause = new Error('programming error');
    manager.insert.mockRejectedValueOnce(cause);
    await expect(service.createArticle(dto, 'author')).rejects.toBe(cause);
  });

  it('returns 404 without loading tags for a missing article', async () => {
    qb.getRawAndEntities.mockResolvedValueOnce({ entities: [], raw: [] });
    await expect(service.getArticle('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(qb.getMany).not.toHaveBeenCalled();
  });

  it('uses exactly two reads for anonymous or authenticated retrieval', async () => {
    const anonymous = await service.getArticle('title');
    expect(anonymous.article.favorited).toBe(false);
    expect(anonymous.article.author.following).toBe(false);
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(2);
    manager.createQueryBuilder.mockClear();
    const authenticated = await service.getArticle('title', 'viewer');
    expect(authenticated.article.favorited).toBe(true);
    expect(authenticated.article.author.following).toBe(true);
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(2);
  });

  describe('updateArticle', () => {
    it('locks the resource, scopes the write by ID/owner and regenerates only a changed title slug', async () => {
      await service.updateArticle(
        'title',
        { title: 'Đường đi', description: 'Changed' },
        'author',
      );
      expect(manager.findOne).toHaveBeenCalledWith(Article, {
        where: { slug: 'title' },
        select: { id: true, authorId: true, title: true, slug: true },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.existsBy).toHaveBeenCalledWith(
        Article,
        expect.objectContaining({ slug: 'duong-di', id: expect.anything() }),
      );
      expect(manager.update).toHaveBeenCalledWith(
        Article,
        { id: 'article-id', authorId: 'author' },
        { title: 'Đường đi', slug: 'duong-di', description: 'Changed' },
      );
      expect(qb.where).toHaveBeenCalledWith('article.slug = :slug', {
        slug: 'duong-di',
      });
      expect(manager.insert).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('does not regenerate a historical/custom slug for an unchanged title', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'article-id',
        authorId: 'author',
        title: 'Title',
        slug: 'custom-slug',
      });
      await service.updateArticle(
        'custom-slug',
        { title: 'Title', body: 'Changed' },
        'author',
      );
      expect(manager.update).toHaveBeenCalledWith(
        Article,
        { id: 'article-id', authorId: 'author' },
        { body: 'Changed' },
      );
      expect(manager.existsBy).not.toHaveBeenCalled();
      expect(qb.where).toHaveBeenCalledWith('article.slug = :slug', {
        slug: 'custom-slug',
      });
    });

    it('treats an empty update as a no-op after checking ownership', async () => {
      const response = await service.updateArticle('title', {}, 'author');
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.findOne).toHaveBeenCalledTimes(1);
      expect(response.article).toMatchObject({
        tagList: ['nestjs'],
        favoritesCount: 3,
        favorited: true,
        author: { following: true },
      });
    });

    it('rejects an existing conflicting slug before writing', async () => {
      manager.existsBy.mockResolvedValueOnce(true);
      await expect(
        service.updateArticle('title', { title: 'Other title' }, 'author'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('allows a changed title which normalizes to the same slug', async () => {
      await service.updateArticle('title', { title: 'TITLE!' }, 'author');
      expect(manager.existsBy).not.toHaveBeenCalled();
      expect(manager.update).toHaveBeenCalledWith(
        Article,
        { id: 'article-id', authorId: 'author' },
        { title: 'TITLE!', slug: 'title' },
      );
    });

    it('turns a database slug collision after the precheck into 409', async () => {
      manager.update.mockRejectedValueOnce(
        failure('ER_DUP_ENTRY', 'IDX_articles_slug_unique'),
      );
      await expect(
        service.updateArticle('title', { title: 'Other' }, 'author'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(qb.getRawAndEntities).not.toHaveBeenCalled();
    });
  });

  describe('deleteArticle', () => {
    it('deletes only the locked resource by UUID/owner and delegates cascades to MySQL', async () => {
      await expect(
        service.deleteArticle('title', 'author'),
      ).resolves.toBeUndefined();
      expect(transaction).toHaveBeenCalledWith(
        'READ COMMITTED',
        expect.any(Function),
      );
      expect(manager.delete).toHaveBeenCalledTimes(1);
      expect(manager.delete).toHaveBeenCalledWith(Article, {
        id: 'article-id',
        authorId: 'author',
      });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe.each(['update', 'delete'] as const)(
    '%s ownership and failure handling',
    (method) => {
      const mutate = () =>
        method === 'update'
          ? service.updateArticle('title', { body: 'Changed' }, 'author')
          : service.deleteArticle('title', 'author');

      it('returns 404 for a missing resource without writing', async () => {
        manager.findOne.mockResolvedValueOnce(null);
        await expect(mutate()).rejects.toBeInstanceOf(NotFoundException);
        expect(manager.update).not.toHaveBeenCalled();
        expect(manager.delete).not.toHaveBeenCalled();
      });

      it('returns 403 for another author without writing', async () => {
        manager.findOne.mockResolvedValueOnce({
          id: 'article-id',
          authorId: 'other',
          title: 'Title',
          slug: 'title',
        });
        await expect(mutate()).rejects.toBeInstanceOf(ForbiddenException);
        expect(manager.update).not.toHaveBeenCalled();
        expect(manager.delete).not.toHaveBeenCalled();
      });

      it('retries a deadlock from a fresh locked read', async () => {
        manager[method].mockRejectedValueOnce(failure('ER_LOCK_DEADLOCK'));
        await mutate();
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(manager.findOne).toHaveBeenCalledTimes(2);
      });

      it('limits deadlock retries, logs once and preserves a sanitized error with its cause', async () => {
        const cause = failure('ER_LOCK_DEADLOCK');
        manager[method].mockRejectedValue(cause);
        const log = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        await expect(mutate()).rejects.toMatchObject({
          status: 500,
          message: 'articles.PERSISTENCE_FAILED',
          cause,
        });
        expect(transaction).toHaveBeenCalledTimes(3);
        expect(log).toHaveBeenCalledTimes(1);
      });

      it('preserves non-database errors without wrapping or duplicate logging', async () => {
        const cause = new Error('unexpected');
        const log = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        manager[method].mockRejectedValueOnce(cause);
        await expect(mutate()).rejects.toBe(cause);
        expect(log).not.toHaveBeenCalled();
      });
    },
  );
});
