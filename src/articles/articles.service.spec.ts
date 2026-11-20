import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
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
});
