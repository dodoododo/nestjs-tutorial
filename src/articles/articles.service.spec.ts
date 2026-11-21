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
    transaction.mockImplementation(
      (_isolation, callback: (manager: unknown) => unknown) =>
        callback(manager),
    );
  });

  afterEach(() => jest.restoreAllMocks());

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
