import {
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { DataSource, In, QueryFailedError } from 'typeorm';
import { Article } from '../database/entities/article.entity';
import { Comment } from '../database/entities/comment.entity';
import { User } from '../database/entities/user.entity';
import { Follow } from '../database/entities/follow.entity';
import { CommentsService } from './comments.service';

describe('CommentsService', () => {
  const authorId = '00000000-0000-4000-8000-000000000001';
  const article = {
    id: '00000000-0000-4000-8000-000000000002',
    authorId: 'someone-else',
    slug: 'current-slug',
  };
  const profile = {
    id: authorId,
    username: 'commenter',
    bio: null,
    image: null,
    email: 'private@example.test',
    passwordHash: 'private-hash',
  };
  const saved = {
    id: '00000000-0000-4000-8000-000000000003',
    articleId: article.id,
    authorId,
    body: '  First\n\nSecond 😀  ',
    createdAt: new Date('2026-01-01T00:00:00.123Z'),
    updatedAt: new Date('2026-01-01T00:00:00.123Z'),
  };
  const query = {
    innerJoin: jest.fn(),
    select: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    getMany: jest.fn(),
  };
  const listed = [
    {
      ...saved,
      createdAt: new Date('2026-01-02T00:00:00.123Z'),
      author: profile,
    },
    {
      ...saved,
      id: '00000000-0000-4000-8000-000000000002',
      author: {
        ...profile,
        id: 'other-author',
        username: 'other',
        bio: 'Bio',
        image: '/avatar.png',
      },
    },
    { ...saved, id: '00000000-0000-4000-8000-000000000001', author: profile },
  ];
  const manager = {
    findOne: jest.fn(),
    save: jest.fn(),
    existsBy: jest.fn(),
    update: jest.fn(),
    transaction: jest.fn(),
    createQueryBuilder: jest.fn(),
    find: jest.fn(),
  };
  let service: CommentsService;
  let log: jest.SpyInstance;
  const failure = (code: string, constraint = 'FK_comments_article_id') =>
    new QueryFailedError(
      'private SQL',
      ['private body'],
      Object.assign(
        new Error(`private driver CONSTRAINT \`${constraint}\` FOREIGN KEY`),
        { code },
      ),
    );

  beforeEach(() => {
    jest.resetAllMocks();
    manager.findOne.mockImplementation((target: unknown) =>
      Promise.resolve(target === Article ? article : profile),
    );
    manager.save.mockResolvedValue(saved);
    manager.existsBy.mockResolvedValue(true);
    for (const method of [
      'innerJoin',
      'select',
      'where',
      'orderBy',
      'addOrderBy',
    ] as const)
      query[method].mockReturnThis();
    query.getMany.mockResolvedValue(listed);
    manager.createQueryBuilder.mockReturnValue(query);
    manager.find.mockResolvedValue([{ followingId: 'other-author' }]);
    log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    service = new CommentsService(
      { manager } as unknown as DataSource,
      { t: (key: string) => key } as I18nService,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  describe('getComments', () => {
    it('scopes the joined public projection to the resolved Article and delegates stable ordering to SQL', async () => {
      const result = await service.getComments(article.slug);
      expect(manager.findOne).toHaveBeenCalledWith(Article, {
        where: { slug: article.slug },
        select: { id: true },
      });
      expect(manager.createQueryBuilder).toHaveBeenCalledWith(
        Comment,
        'comment',
      );
      expect(query.innerJoin).toHaveBeenCalledWith('comment.author', 'author');
      expect(query.select).toHaveBeenCalledWith([
        'comment.id',
        'comment.body',
        'comment.createdAt',
        'comment.updatedAt',
        'author.id',
        'author.username',
        'author.bio',
        'author.image',
      ]);
      expect(query.where).toHaveBeenCalledWith(
        'comment.articleId = :articleId',
        { articleId: article.id },
      );
      expect(query.orderBy).toHaveBeenCalledWith('comment.createdAt', 'DESC');
      expect(query.addOrderBy).toHaveBeenCalledWith('comment.id', 'DESC');
      expect(result).toEqual({
        comments: listed.map((comment) => ({
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt.toISOString(),
          updatedAt: comment.updatedAt.toISOString(),
          author: {
            username: comment.author.username,
            bio: comment.author.bio,
            image: comment.author.image,
            following: false,
          },
        })),
      });
      expect(manager.find).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it.each([undefined, 'viewer-id'])(
      'returns an empty array without a Follow query for viewer %s',
      async (viewerId) => {
        query.getMany.mockResolvedValueOnce([]);
        expect(await service.getComments(article.slug, viewerId)).toEqual({
          comments: [],
        });
        expect(manager.find).not.toHaveBeenCalled();
      },
    );

    it('returns a localized 404 before loading Comments for an unknown Article', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getComments('unknown', 'viewer-id'),
      ).rejects.toMatchObject({
        status: 404,
        message: 'comments.ARTICLE_NOT_FOUND',
      });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(manager.find).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('loads only followed IDs in one parameterized, deduplicated batch for this viewer', async () => {
      const result = await service.getComments(article.slug, 'viewer-id');
      expect(manager.find).toHaveBeenCalledTimes(1);
      expect(manager.find).toHaveBeenCalledWith(Follow, {
        where: {
          followerId: 'viewer-id',
          followingId: In([authorId, 'other-author']),
        },
        select: { followingId: true },
      });
      expect(
        result.comments.map((comment) => comment.author.following),
      ).toEqual([false, true, false]);
    });

    it('maps all matching authors as followed and does not consult relationships for anonymous viewers', async () => {
      manager.find.mockResolvedValueOnce([
        { followingId: authorId },
        { followingId: 'other-author' },
      ]);
      expect(
        (await service.getComments(article.slug, 'viewer-id')).comments.every(
          (comment) => comment.author.following,
        ),
      ).toBe(true);
      manager.find.mockClear();
      expect(
        (await service.getComments(article.slug)).comments.every(
          (comment) => !comment.author.following,
        ),
      ).toBe(true);
      expect(manager.find).not.toHaveBeenCalled();
    });

    it('keeps query calls constant for twenty comments sharing an author, including mapping', async () => {
      query.getMany.mockResolvedValueOnce(
        Array.from({ length: 20 }, (_, index) => ({
          ...listed[0],
          id: String(index),
        })),
      );
      const result = await service.getComments(article.slug, 'viewer-id');
      expect(result.comments).toHaveLength(20);
      expect(manager.findOne).toHaveBeenCalledTimes(1);
      expect(query.getMany).toHaveBeenCalledTimes(1);
      expect(manager.find).toHaveBeenCalledTimes(1);
      expect(manager.find).toHaveBeenCalledWith(Follow, {
        where: { followerId: 'viewer-id', followingId: In([authorId]) },
        select: { followingId: true },
      });
    });

    it.each(['article lookup', 'comment query', 'follow query'])(
      'sanitizes database errors in %s and preserves their diagnostic cause',
      async (step) => {
        const cause = failure('ER_BAD_FIELD_ERROR');
        if (step === 'article lookup')
          manager.findOne.mockRejectedValueOnce(cause);
        if (step === 'comment query')
          query.getMany.mockRejectedValueOnce(cause);
        if (step === 'follow query') manager.find.mockRejectedValueOnce(cause);
        let caught: unknown;
        try {
          await service.getComments(article.slug, 'viewer-id');
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({
          status: 500,
          cause,
          message: 'comments.RETRIEVAL_FAILED',
        });
        expect(
          JSON.stringify(
            (caught as InternalServerErrorException).getResponse(),
          ),
        ).not.toMatch(/SQL|private|stack|constraint|query/i);
        expect(log).toHaveBeenCalledWith('Comment retrieval failed', {
          errorType: 'QueryFailedError',
          code: 'ER_BAD_FIELD_ERROR',
        });
        expect(JSON.stringify(log.mock.calls)).not.toMatch(
          /SQL|private|body|password|token/i,
        );
      },
    );

    it('sanitizes unexpected non-database errors too', async () => {
      const cause = new Error('private request content');
      query.getMany.mockRejectedValueOnce(cause);
      await expect(service.getComments(article.slug)).rejects.toMatchObject({
        status: 500,
        cause,
        message: 'comments.RETRIEVAL_FAILED',
      });
      expect(log).toHaveBeenCalledWith('Comment retrieval failed', {
        errorType: 'Error',
        code: undefined,
      });
    });
  });

  it('looks up the current slug, persists only principal identity and body, and returns the public contract', async () => {
    const dto = {
      body: saved.body,
      authorId: 'forged',
      articleId: 'forged',
      id: 'forged',
    };
    const result = await service.createComment(article.slug, dto, authorId);
    expect(manager.findOne.mock.calls).toEqual([
      [Article, { where: { slug: article.slug }, select: { id: true } }],
      [
        User,
        {
          where: { id: authorId },
          select: { username: true, bio: true, image: true },
        },
      ],
    ]);
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(
      Comment,
      { articleId: article.id, authorId, body: saved.body },
      { transaction: false },
    );
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.transaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      comment: {
        id: saved.id,
        body: saved.body,
        createdAt: saved.createdAt.toISOString(),
        updatedAt: saved.updatedAt.toISOString(),
        author: {
          username: 'commenter',
          bio: null,
          image: null,
          following: false,
        },
      },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('explicitly returns 404 for a nonexistent article without creating a comment', async () => {
    manager.findOne.mockResolvedValueOnce(null);
    await expect(
      service.createComment('unknown', { body: 'Body' }, authorId),
    ).rejects.toMatchObject({
      status: 404,
      message: 'comments.ARTICLE_NOT_FOUND',
    });
    expect(manager.findOne).toHaveBeenCalledTimes(1);
    expect(manager.save).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('returns 401 if the authenticated author disappears before loading their profile', async () => {
    manager.findOne.mockResolvedValueOnce(article).mockResolvedValueOnce(null);
    await expect(
      service.createComment(article.slug, { body: 'Body' }, authorId),
    ).rejects.toMatchObject({ status: 401 });
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('allows the article owner to comment with populated profile values', async () => {
    manager.findOne
      .mockResolvedValueOnce({ ...article, authorId })
      .mockResolvedValueOnce({ ...profile, bio: 'Bio', image: '/avatar.png' });
    const result = await service.createComment(
      article.slug,
      { body: saved.body },
      authorId,
    );
    expect(result.comment.author).toEqual({
      username: 'commenter',
      bio: 'Bio',
      image: '/avatar.png',
      following: false,
    });
  });

  it('returns 404 for a confirmed concurrent article deletion after its specific FK failure', async () => {
    manager.save.mockRejectedValueOnce(failure('ER_NO_REFERENCED_ROW_2'));
    manager.existsBy.mockResolvedValueOnce(false);
    await expect(
      service.createComment(article.slug, { body: 'Body' }, authorId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.existsBy).toHaveBeenCalledWith(Article, { id: article.id });
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    [
      'article FK with parent still present',
      'ER_NO_REFERENCED_ROW_2',
      'FK_comments_article_id',
      true,
    ],
    [
      'author FK even when article is missing',
      'ER_NO_REFERENCED_ROW_2',
      'FK_comments_author_id',
      false,
    ],
    ['unrecognized FK', 'ER_NO_REFERENCED_ROW_2', 'another_constraint', false],
    [
      'unrelated database failure',
      'ER_BAD_FIELD_ERROR',
      'FK_comments_article_id',
      false,
    ],
  ])(
    'sanitizes %s without converting it to Article Not Found',
    async (_label, code, constraint, exists) => {
      const cause = failure(code as string, constraint as string);
      manager.save.mockRejectedValueOnce(cause);
      manager.existsBy.mockResolvedValueOnce(exists);
      let caught: unknown;
      try {
        await service.createComment(article.slug, { body: 'Body' }, authorId);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InternalServerErrorException);
      expect(caught).toMatchObject({
        cause,
        message: 'comments.PERSISTENCE_FAILED',
      });
      expect(
        JSON.stringify((caught as InternalServerErrorException).getResponse()),
      ).not.toMatch(/private|SQL|constraint|stack/i);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /private|SQL|constraint|body|password|token/i,
      );
      expect(log).toHaveBeenCalledWith('Comment creation failed', {
        errorType: 'QueryFailedError',
        code,
      });
      expect(manager.existsBy).toHaveBeenCalledTimes(
        constraint === 'FK_comments_article_id' &&
          code === 'ER_NO_REFERENCED_ROW_2'
          ? 1
          : 0,
      );
    },
  );

  it.each(['article lookup', 'profile lookup', 'save', 'race confirmation'])(
    'logs and sanitizes unexpected failures during %s with their original cause',
    async (step) => {
      const cause = new Error('private request body or secret');
      if (step === 'article lookup')
        manager.findOne.mockRejectedValueOnce(cause);
      if (step === 'profile lookup')
        manager.findOne
          .mockResolvedValueOnce(article)
          .mockRejectedValueOnce(cause);
      if (step === 'save') manager.save.mockRejectedValueOnce(cause);
      if (step === 'race confirmation') {
        manager.save.mockRejectedValueOnce(failure('ER_NO_REFERENCED_ROW_2'));
        manager.existsBy.mockRejectedValueOnce(cause);
      }
      await expect(
        service.createComment(article.slug, { body: 'Body' }, authorId),
      ).rejects.toMatchObject({
        status: 500,
        message: 'comments.PERSISTENCE_FAILED',
        cause,
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /private|secret|body/i,
      );
    },
  );
});
