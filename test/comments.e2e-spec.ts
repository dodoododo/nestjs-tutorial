import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { OpenAPIObject } from '@nestjs/swagger';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  DataSource,
  EntityManager,
  In,
  QueryFailedError,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { AppModule } from '../src/app.module';
import { INVALID_USER_PASSWORD_HASH } from '../src/auth/constants/auth.constant';
import { CommentResponseDto } from '../src/comments/dto/comment-response.dto';
import { CommentsResponseDto } from '../src/comments/dto/comments-response.dto';
import { COMMENT_BODY_MAX_BYTES } from '../src/comments/constants/comment.constant';
import { Article } from '../src/database/entities/article.entity';
import { Comment } from '../src/database/entities/comment.entity';
import { User } from '../src/database/entities/user.entity';
import { Follow } from '../src/database/entities/follow.entity';
import {
  REDIS_CLIENT,
  REVOCATION_KEY_PREFIX,
} from '../src/redis/redis.constant';
import { setupSwagger } from '../src/swagger';

describe('Comment APIs (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let users: Repository<User>;
  let articles: Repository<Article>;
  let comments: Repository<Comment>;
  let owner: User;
  let commenter: User;
  let article: Article;
  let unrelated: Article;
  let token: string;
  const userIds: string[] = [];
  const revocationKeys: string[] = [];

  function post(
    payload: unknown = {
      comment: { body: '  Useful article!\n\nThanks 😀  ' },
    },
    authorization: string | null = `Bearer ${token}`,
    slug = article.slug,
  ) {
    const req = request(app.getHttpServer()).post(
      `/api/articles/${encodeURIComponent(slug)}/comments`,
    );
    if (authorization !== null) req.set('Authorization', authorization);
    return req.send(payload as object);
  }
  const ownCount = () => comments.countBy({ authorId: In(userIds) });

  function get(authorization?: string, slug = article.slug) {
    const req = request(app.getHttpServer()).get(
      `/api/articles/${encodeURIComponent(slug)}/comments`,
    );
    if (authorization !== undefined) req.set('Authorization', authorization);
    return req;
  }

  async function seedComments(
    count: number,
    authorIds = [owner.id, commenter.id],
  ) {
    const rows = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      articleId: article.id,
      authorId: authorIds[index % authorIds.length],
      body: `  Comment ${index}\n\nThanks 😀  `,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(index / 2))),
      updatedAt: new Date('2026-01-02T00:00:00.123Z'),
    }));
    // Keep independent expected timestamps before TypeORM mutates insert inputs.
    const expected = rows
      .map((row) => ({ ...row }))
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.id < b.id ? 1 : -1),
      );
    await comments.insert(rows);
    return expected;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    setupSwagger(app);
    await app.init();
    dataSource = app.get(DataSource);
    redis = app.get<Redis>(REDIS_CLIENT);
    if (
      process.env.NODE_ENV !== 'test' ||
      dataSource.options.type !== 'mysql' ||
      dataSource.options.host !== '127.0.0.1' ||
      dataSource.options.port !== 3308 ||
      dataSource.options.database !== 'nestjs_tutorial_test' ||
      dataSource.options.synchronize !== false ||
      dataSource.options.migrationsRun !== false ||
      redis.options.host !== '127.0.0.1' ||
      redis.options.port !== 6380
    )
      throw new Error(
        'Unsafe Comment API test database or Redis configuration',
      );
    expect(await redis.ping()).toBe('PONG');
    expect(await dataSource.showMigrations()).toBe(false);
    users = dataSource.getRepository(User);
    articles = dataSource.getRepository(Article);
    comments = dataSource.getRepository(Comment);
  });
  beforeEach(async () => {
    const fixtures = Array.from({ length: 2 }, (_, index) => {
      const id = randomUUID();
      userIds.push(id);
      return {
        id,
        username: `c_${id}`,
        email: `c_${id}@example.test`,
        passwordHash: INVALID_USER_PASSWORD_HASH,
        bio: index ? 'Commenter biography' : null,
        image: index ? '/uploads/avatars/commenter.png' : null,
      };
    });
    [owner, commenter] = await users.save(fixtures);
    [article, unrelated] = await articles.save(
      [owner, commenter].map((author) => ({
        id: randomUUID(),
        slug: `comment-api-${randomUUID()}`,
        title: 'Existing article',
        description: 'Description',
        body: 'Article content',
        authorId: author.id,
      })),
    );
    token = await app
      .get(JwtService)
      .signAsync({ sub: commenter.id, jti: randomUUID() });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (userIds.length) await users.delete({ id: In(userIds.splice(0)) });
    if (revocationKeys.length) await redis.del(...revocationKeys.splice(0));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('returns 201 and only the public comment contract for a different article author', async () => {
    const body = '  Useful article!\n\nThanks 😀  ';
    const response = await post({ comment: { body } }).expect(201);
    const result = (response.body as CommentResponseDto).comment;
    expect(response.body).toEqual({
      comment: {
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        body,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        author: {
          username: commenter.username,
          bio: commenter.bio,
          image: commenter.image,
          following: false,
        },
      },
    });
    const saved = await comments.findOneByOrFail({ id: result.id });
    expect(saved).toMatchObject({
      articleId: article.id,
      authorId: commenter.id,
      body,
    });
    expect(result.createdAt).toBe(saved.createdAt.toISOString());
    expect(result.updatedAt).toBe(saved.updatedAt.toISOString());
    expect(await articles.findOneByOrFail({ id: article.id })).toEqual(article);
  });

  it('allows own-article comments and repeated comments without changing other articles or comments', async () => {
    const retained = await comments.save({
      articleId: article.id,
      authorId: owner.id,
      body: 'Existing comment',
    });
    const first = await post(undefined, undefined, unrelated.slug).expect(201);
    const second = await post(undefined, undefined, unrelated.slug).expect(201);
    expect((first.body as CommentResponseDto).comment.id).not.toBe(
      (second.body as CommentResponseDto).comment.id,
    );
    expect(
      await comments.countBy({
        articleId: unrelated.id,
        authorId: commenter.id,
      }),
    ).toBe(2);
    expect(await comments.findOneByOrFail({ id: retained.id })).toEqual(
      retained,
    );
    expect(await articles.findOneByOrFail({ id: article.id })).toEqual(article);
    expect(await articles.findOneByOrFail({ id: unrelated.id })).toEqual(
      unrelated,
    );
  });

  it('returns the creating author with nullable profile values', async () => {
    const ownToken = await app
      .get(JwtService)
      .signAsync({ sub: owner.id, jti: randomUUID() });
    const response = await post(undefined, `Bearer ${ownToken}`).expect(201);
    expect((response.body as CommentResponseDto).comment.author).toEqual({
      username: owner.username,
      bio: null,
      image: null,
      following: false,
    });
  });

  it('uses the current slug and stable Article UUID after a slug change', async () => {
    const newSlug = `renamed-${randomUUID()}`;
    await articles.update(article.id, { slug: newSlug });
    await post().expect(404);
    const response = await post(undefined, undefined, newSlug).expect(201);
    expect(
      await comments.findOneByOrFail({
        id: (response.body as CommentResponseDto).comment.id,
      }),
    ).toMatchObject({ articleId: article.id });
  });

  it.each([
    {},
    { comment: null },
    { comment: [] },
    { comment: [{ body: 'Text' }] },
    { comment: 'Text' },
    { comment: 1 },
    { comment: true },
    { comment: {} },
    ...[
      null,
      '',
      ' \n\t ',
      123,
      false,
      {},
      [],
      ['text'],
      '\ud800',
      '\udc00',
      'before\ud800after',
    ].map((body) => ({ comment: { body } })),
    ...[
      'authorId',
      'articleId',
      'commentId',
      'id',
      'author',
      'createdAt',
      'updatedAt',
      'unknown',
    ].flatMap((field) => [
      { comment: { body: 'Text', [field]: 'forged' } },
      { comment: { body: 'Text' }, [field]: 'forged' },
    ]),
  ])(
    'rejects malformed input and forged ownership without a write (case %#)',
    async (payload) => {
      await post(payload).expect(400);
      expect(await ownCount()).toBe(0);
    },
  );

  it.each([
    'a'.repeat(COMMENT_BODY_MAX_BYTES),
    '€'.repeat(21_845),
    '😀'.repeat(16_383) + 'abc',
  ])('persists exactly 65535 UTF-8 bytes (case %#)', async (body) => {
    expect(Buffer.byteLength(body, 'utf8')).toBe(COMMENT_BODY_MAX_BYTES);
    const response = await post({ comment: { body } }).expect(201);
    const result = (response.body as CommentResponseDto).comment;
    expect(result.body).toBe(body);
    expect((await comments.findOneByOrFail({ id: result.id })).body).toBe(body);
  });
  it.each([
    'a'.repeat(COMMENT_BODY_MAX_BYTES + 1),
    '€'.repeat(21_846),
    '😀'.repeat(16_384),
    'a'.repeat(COMMENT_BODY_MAX_BYTES) + ' ',
  ])(
    'rejects oversized UTF-8 bodies before persistence (case %#)',
    async (body) => {
      await post({ comment: { body } }).expect(400);
      expect(await ownCount()).toBe(0);
    },
  );

  it.each([
    null,
    '',
    'Bearer',
    'Basic credentials',
    'Bearer invalid.jwt.token',
  ])('requires a valid Bearer JWT (case %#)', async (credential) => {
    await post(undefined, credential).expect(401);
    expect(await ownCount()).toBe(0);
  });
  it.each(['expired', 'incorrect signature', 'revoked', 'deleted user'])(
    'rejects %s JWTs without creating comments',
    async (kind) => {
      const jwt = app.get(JwtService);
      let credential = token;
      if (kind === 'expired')
        credential = await jwt.signAsync(
          { sub: commenter.id, jti: randomUUID() },
          { expiresIn: -1 },
        );
      if (kind === 'incorrect signature')
        credential = await jwt.signAsync(
          { sub: commenter.id, jti: randomUUID() },
          { secret: 'different-secret-with-at-least-32-bytes' },
        );
      if (kind === 'revoked') {
        const { jti } = await jwt.verifyAsync<{ jti: string }>(token);
        revocationKeys.push(`${REVOCATION_KEY_PREFIX}${jti}`);
        await request(app.getHttpServer())
          .post('/api/logout')
          .set('Authorization', `Bearer ${token}`)
          .expect(204);
      }
      if (kind === 'deleted user') await users.delete(commenter.id);
      await post(undefined, `Bearer ${credential}`).expect(401);
      expect(await ownCount()).toBe(0);
    },
  );

  it('fails closed with 503 when the real Redis revocation lookup fails', async () => {
    jest
      .spyOn(redis, 'get')
      .mockRejectedValueOnce(new Error('Connection unavailable'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await post().expect(503);
    expect(await ownCount()).toBe(0);
  });

  it('explicitly returns 404 for a nonexistent article and creates no Comment', async () => {
    const result = await post(
      undefined,
      undefined,
      `missing-${randomUUID()}`,
    ).expect(404);
    expect(result.body.message).toBe('Article not found for this comment');
    expect(await ownCount()).toBe(0);
  });
  it('translates Article-not-found errors to Vietnamese', async () => {
    const result = await post(undefined, undefined, `missing-${randomUUID()}`)
      .query({ lang: 'vi' })
      .expect(404);
    expect(result.body.message).toBe(
      'Không tìm thấy bài viết cho bình luận này',
    );
  });

  it('handles a real concurrent Article deletion with 404 and no orphan', async () => {
    const find = jest.spyOn(dataSource.manager, 'findOne');
    const original = find.getMockImplementation()!;
    find.mockImplementation(async function (
      this: EntityManager,
      target,
      options,
    ) {
      const result = await original.call(this, target, options);
      if (target === Article) await articles.delete(article.id);
      return result;
    });
    await post().expect(404);
    expect(await ownCount()).toBe(0);
    expect(await articles.existsBy({ id: article.id })).toBe(false);
    expect(await articles.existsBy({ id: unrelated.id })).toBe(true);
  });

  it.each(['en', 'vi'])(
    'sanitizes unexpected database errors and translates persistence failures (%s)',
    async (lang) => {
      const cause = new QueryFailedError(
        'private SQL',
        ['private body'],
        Object.assign(new Error('private driver details'), {
          code: 'ER_BAD_FIELD_ERROR',
        }),
      );
      jest.spyOn(dataSource.manager, 'save').mockRejectedValueOnce(cause);
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const response = await post().query({ lang }).expect(500);
      expect(response.body.message).toBe(
        lang === 'vi'
          ? 'Không thể tạo bình luận'
          : 'Unable to create the comment',
      );
      expect(JSON.stringify(response.body)).not.toMatch(
        /private|SQL|stack|query|path|password|token/i,
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /private|SQL|body|password|token/i,
      );
      expect(log).toHaveBeenCalledWith('Comment creation failed', {
        errorType: 'QueryFailedError',
        code: 'ER_BAD_FIELD_ERROR',
      });
      expect(await ownCount()).toBe(0);
      expect(await articles.findOneByOrFail({ id: article.id })).toEqual(
        article,
      );
    },
  );

  describe('GET Comments', () => {
    it('marks viewer-specific responses private and non-storable for anonymous and different authenticated viewers', async () => {
      const [row] = await seedComments(1, [owner.id]);
      await dataSource.getRepository(Follow).insert({
        followerId: commenter.id,
        followingId: owner.id,
      });
      const ownerToken = await app.get(JwtService).signAsync({
        sub: owner.id,
        jti: randomUUID(),
      });
      const cacheControls: (string | undefined)[] = [];
      const viewers = [
        { authorization: undefined, following: false },
        { authorization: `Bearer ${token}`, following: true },
        { authorization: `Bearer ${ownerToken}`, following: false },
      ];
      for (const viewer of viewers) {
        const response = await get(viewer.authorization).expect(200);
        expect((response.body as CommentsResponseDto).comments).toEqual([
          expect.objectContaining({
            id: row.id,
            author: expect.objectContaining({ following: viewer.following }),
          }),
        ]);
        cacheControls.push(response.headers['cache-control']);
      }
      expect(cacheControls).toEqual(Array(3).fill('private, no-store'));
    });

    it.each([false, true])(
      'returns an empty array for an existing article (authenticated=%s)',
      async (authenticated) => {
        const response = await get(
          authenticated ? `Bearer ${token}` : undefined,
        ).expect(200);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.body).toEqual({ comments: [] });
      },
    );

    it('returns a newly POSTed comment using the same public representation', async () => {
      const created = await post().expect(201);
      const expected = (created.body as CommentResponseDto).comment;
      for (const credential of [undefined, `Bearer ${token}`]) {
        const response = await get(credential).expect(200);
        expect(response.body).toEqual({ comments: [expected] });
      }
      expect(await articles.findOneByOrFail({ id: article.id })).toEqual(
        article,
      );
    });

    it('isolates articles, preserves public profiles/body/dates, and orders timestamp ties by UUID on repeated reads', async () => {
      const expected = await seedComments(5);
      await comments.insert({
        articleId: unrelated.id,
        authorId: owner.id,
        body: 'Other article only',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await get().expect(200);
        expect(response.body).toEqual({
          comments: expected.map((row) => {
            const author = row.authorId === owner.id ? owner : commenter;
            return {
              id: row.id,
              body: row.body,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
              author: {
                username: author.username,
                bio: author.bio,
                image: author.image,
                following: false,
              },
            };
          }),
        });
      }
    });

    it.each([false, true])(
      'returns 404 for an unknown Article (authenticated=%s)',
      async (authenticated) => {
        const response = await get(
          authenticated ? `Bearer ${token}` : undefined,
          `unknown-${randomUUID()}`,
        ).expect(404);
        expect(response.body.message).toBe(
          'Article not found for this comment',
        );
      },
    );

    it('uses the current slug and localizes a missing Article', async () => {
      const [row] = await seedComments(1);
      const newSlug = `renamed-${randomUUID()}`;
      await articles.update(article.id, { slug: newSlug });
      const missing = await get().query({ lang: 'vi' }).expect(404);
      expect(missing.body.message).toBe(
        'Không tìm thấy bài viết cho bình luận này',
      );
      const response = await get(undefined, newSlug).expect(200);
      expect(
        (response.body as CommentsResponseDto).comments.map(
          (comment) => comment.id,
        ),
      ).toEqual([row.id]);
    });

    it('uses stored Follow direction, supports multiple followed authors and reflects unfollow without caching', async () => {
      const id = randomUUID();
      userIds.push(id);
      const third = await users.save({
        id,
        username: `c_${id}`,
        email: `c_${id}@example.test`,
        passwordHash: INVALID_USER_PASSWORD_HASH,
        bio: 'Third author',
        image: '/third.png',
      });
      await seedComments(6, [owner.id, third.id, commenter.id]);
      await dataSource
        .getRepository(Follow)
        .insert({ followerId: owner.id, followingId: commenter.id });
      const initial = await get(`Bearer ${token}`).expect(200);
      expect(
        (initial.body as CommentsResponseDto).comments.every(
          (comment) => !comment.author.following,
        ),
      ).toBe(true);
      for (const author of [owner, third]) {
        const followed = await request(app.getHttpServer())
          .post(`/api/profiles/${author.username}/follow`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(followed.body).toEqual({
          profile: {
            username: author.username,
            bio: author.bio,
            image: author.image,
            following: true,
          },
        });
      }
      const response = await get(`Bearer ${token}`).expect(200);
      for (const comment of (response.body as CommentsResponseDto).comments) {
        expect(comment.author.following).toBe(
          comment.author.username !== commenter.username,
        );
      }
      await request(app.getHttpServer())
        .delete(`/api/profiles/${owner.username}/follow`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const after = await get(`Bearer ${token}`).expect(200);
      for (const comment of (after.body as CommentsResponseDto).comments) {
        expect(comment.author.following).toBe(
          comment.author.username === third.username,
        );
      }
      const anonymous = await get().expect(200);
      expect(
        (anonymous.body as CommentsResponseDto).comments.every(
          (comment) => !comment.author.following,
        ),
      ).toBe(true);
    });

    it('never takes Article or viewer identity from query parameters', async () => {
      const rows = await seedComments(2);
      await dataSource
        .getRepository(Follow)
        .insert({ followerId: commenter.id, followingId: owner.id });
      const query = {
        articleId: unrelated.id,
        viewerId: commenter.id,
        userId: commenter.id,
        authorId: owner.id,
      };
      const anonymous = await get().query(query).expect(200);
      expect(
        (anonymous.body as CommentsResponseDto).comments.map(
          (comment) => comment.id,
        ),
      ).toEqual(rows.map((row) => row.id));
      expect(
        (anonymous.body as CommentsResponseDto).comments.every(
          (comment) => !comment.author.following,
        ),
      ).toBe(true);
      const ownerToken = await app
        .get(JwtService)
        .signAsync({ sub: owner.id, jti: randomUUID() });
      const authenticated = await get(`Bearer ${ownerToken}`)
        .query(query)
        .expect(200);
      expect(
        (authenticated.body as CommentsResponseDto).comments.every(
          (comment) => !comment.author.following,
        ),
      ).toBe(true);
      const actualViewer = await get(`Bearer ${token}`).expect(200);
      expect(
        (actualViewer.body as CommentsResponseDto).comments.find(
          (comment) => comment.author.username === owner.username,
        )!.author.following,
      ).toBe(true);
    });

    it.each([
      '',
      'Bearer',
      'Basic credentials',
      'Token wrong-scheme',
      'Bearer invalid.jwt.token',
    ])(
      'rejects malformed supplied Authorization instead of becoming anonymous (case %#)',
      async (credential) => {
        await get(credential).expect(401);
      },
    );
    it.each(['expired', 'incorrect signature', 'revoked', 'deleted user'])(
      'rejects supplied %s credentials',
      async (kind) => {
        const jwt = app.get(JwtService);
        let credential = token;
        if (kind === 'expired')
          credential = await jwt.signAsync(
            { sub: commenter.id, jti: randomUUID() },
            { expiresIn: -1 },
          );
        if (kind === 'incorrect signature')
          credential = await jwt.signAsync(
            { sub: commenter.id, jti: randomUUID() },
            { secret: 'different-secret-with-at-least-32-bytes' },
          );
        if (kind === 'revoked') {
          const { jti } = await jwt.verifyAsync<{ jti: string }>(token);
          revocationKeys.push(`${REVOCATION_KEY_PREFIX}${jti}`);
          await request(app.getHttpServer())
            .post('/api/logout')
            .set('Authorization', `Bearer ${token}`)
            .expect(204);
        }
        if (kind === 'deleted user') await users.delete(commenter.id);
        await get(`Bearer ${credential}`).expect(401);
      },
    );

    it('allows anonymous reads during Redis failure but fails closed for supplied valid credentials', async () => {
      await seedComments(1);
      const check = jest
        .spyOn(redis, 'get')
        .mockRejectedValue(new Error('Connection unavailable'));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await get().expect(200);
      expect(check).not.toHaveBeenCalled();
      await get(`Bearer ${token}`).expect(503);
      expect(check).toHaveBeenCalledTimes(1);
    });

    it.each(['en', 'vi'])(
      'sanitizes and translates retrieval errors (%s)',
      async (lang) => {
        const cause = new QueryFailedError(
          'private SQL',
          [],
          Object.assign(new Error('private driver content'), {
            code: 'ER_BAD_FIELD_ERROR',
          }),
        );
        jest
          .spyOn(SelectQueryBuilder.prototype, 'getMany')
          .mockRejectedValueOnce(cause);
        const log = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        const response = await get().query({ lang }).expect(500);
        expect(response.body.message).toBe(
          lang === 'vi'
            ? 'Không thể truy xuất bình luận'
            : 'Unable to retrieve comments',
        );
        expect(JSON.stringify(response.body)).not.toMatch(
          /private|SQL|stack|query|path|password|token/i,
        );
        expect(JSON.stringify(log.mock.calls)).not.toMatch(
          /private|SQL|body|password|token/i,
        );
        expect(log).toHaveBeenCalledWith('Comment retrieval failed', {
          errorType: 'QueryFailedError',
          code: 'ER_BAD_FIELD_ERROR',
        });
      },
    );

    it.each([false, true])(
      'bounds SQL statements for 1 and 20 Comments without per-author queries (authenticated=%s)',
      async (authenticated) => {
        await dataSource
          .getRepository(Follow)
          .insert({ followerId: commenter.id, followingId: owner.id });
        const sql = jest.spyOn(dataSource.logger, 'logQuery');
        for (const count of [1, 20]) {
          await comments.delete({ articleId: article.id });
          await seedComments(count);
          sql.mockClear();
          const response = await get(
            authenticated ? `Bearer ${token}` : undefined,
          ).expect(200);
          expect((response.body as CommentsResponseDto).comments).toHaveLength(
            count,
          );
          const statements = sql.mock.calls.map(([statement]) => statement);
          // Authenticated HTTP reads include one existing JWT User lookup.
          expect(statements).toHaveLength(authenticated ? 4 : 2);
          const commentQueries = statements.filter((statement) =>
            statement.includes('FROM `comments`'),
          );
          expect(commentQueries).toHaveLength(1);
          expect(commentQueries[0]).toContain('INNER JOIN `users` `author`');
          expect(commentQueries[0]).toMatch(
            /WHERE .*`comment`\.`article_id` = \?/,
          );
          expect(commentQueries[0]).toContain(
            'ORDER BY `comment_created_at` DESC, `comment_id` DESC',
          );
          expect(commentQueries[0]).not.toMatch(
            /`author`\.`(?:email|password_hash|role)`/i,
          );
          const articleQueries = statements.filter((statement) =>
            statement.includes('FROM `articles`'),
          );
          expect(articleQueries).toHaveLength(1);
          expect(articleQueries[0]).not.toContain('body');
          const followQueries = statements.filter((statement) =>
            statement.includes('FROM `follows`'),
          );
          expect(followQueries).toHaveLength(authenticated ? 1 : 0);
          if (authenticated) {
            expect(followQueries[0]).toContain('`follower_id` = ?');
            expect(followQueries[0]).toMatch(/`following_id` IN \(\?/);
            expect(followQueries[0].split(' FROM ')[0]).not.toMatch(
              /follower_id|created_at|updated_at/,
            );
          }
        }
      },
    );

    it('does not query Follow metadata for an empty authenticated list', async () => {
      const sql = jest.spyOn(dataSource.logger, 'logQuery');
      const response = await get(`Bearer ${token}`).expect(200);
      expect(response.body).toEqual({ comments: [] });
      const statements = sql.mock.calls.map(([statement]) => statement);
      expect(statements).toHaveLength(3);
      expect(
        statements.some((statement) => statement.includes('FROM `follows`')),
      ).toBe(false);
    });
  });

  it('documents implemented POST and GET routes with shared Comment DTOs and optional GET auth', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as OpenAPIObject;
    const path = document.paths['/api/articles/{slug}/comments'];
    expect(path.post).toBeDefined();
    expect(path.get).toBeDefined();
    expect(path.delete).toBeUndefined();
    expect(path.post!.security).toEqual([{ bearer: [] }]);
    expect(path.get!.security).toEqual([{}, { bearer: [] }]);
    expect(Object.keys(path.get!.responses).sort()).toEqual([
      '200',
      '401',
      '404',
      '500',
      '503',
    ]);
    expect(path.get!.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CommentsResponseDto' },
        },
      },
    });
    expect(path.get!.parameters).toEqual([
      expect.objectContaining({ name: 'slug', in: 'path', required: true }),
    ]);
    expect(document.components!.schemas!.CommentsResponseDto).toMatchObject({
      required: ['comments'],
      properties: {
        comments: {
          type: 'array',
          items: { $ref: '#/components/schemas/CommentDto' },
        },
      },
    });
    expect(Object.keys(path.post!.responses).sort()).toEqual([
      '201',
      '400',
      '401',
      '404',
      '500',
      '503',
    ]);
    expect(path.post!.parameters).toContainEqual(
      expect.objectContaining({ name: 'slug', in: 'path', required: true }),
    );
    expect(path.post!.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CreateCommentRequestDto' },
        },
      },
    });
    expect(document.components!.schemas!.CreateCommentRequestDto).toMatchObject(
      {
        required: ['comment'],
        properties: {
          comment: { $ref: '#/components/schemas/CreateCommentDto' },
        },
      },
    );
    expect(document.components!.schemas!.CreateCommentDto).toMatchObject({
      required: ['body'],
    });
    expect(document.components!.schemas!.CommentDto).toMatchObject({
      properties: {
        id: { format: 'uuid' },
        createdAt: { format: 'date-time' },
        updatedAt: { format: 'date-time' },
      },
    });
  });
});
