import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { CommentResponseDto } from '../src/comments/dto/comment-response.dto';
import { CommentsResponseDto } from '../src/comments/dto/comments-response.dto';
import { COMMENT_BODY_MAX_BYTES } from '../src/comments/constants/comment.constant';
import { CommentsService } from '../src/comments/comments.service';
import { COMMENT_JSON_MAX_BYTES } from '../src/comments/comment-body-parser';
import { configureHttpApplication } from '../src/configure-http-application';
import { Article } from '../src/database/entities/article.entity';
import { Comment } from '../src/database/entities/comment.entity';
import { User } from '../src/database/entities/user.entity';
import { Follow } from '../src/database/entities/follow.entity';
import { Tag } from '../src/database/entities/tag.entity';
import { ArticleTag } from '../src/database/entities/article-tag.entity';
import { ArticleFavorite } from '../src/database/entities/article-favorite.entity';
import {
  REDIS_CLIENT,
  REVOCATION_KEY_PREFIX,
} from '../src/redis/redis.constant';
import { setupSwagger } from '../src/swagger';

describe('Comment APIs (e2e)', () => {
  let app: NestExpressApplication;
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
  const tagIds: string[] = [];

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

  function remove(
    id: string,
    authorization: string | null = `Bearer ${token}`,
    slug = article.slug,
  ) {
    const req = request(app.getHttpServer()).delete(
      `/api/articles/${encodeURIComponent(slug)}/comments/${encodeURIComponent(id)}`,
    );
    if (authorization !== null) req.set('Authorization', authorization);
    return req;
  }

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
    configureHttpApplication(app);
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
    if (tagIds.length)
      await dataSource.getRepository(Tag).delete({ id: In(tagIds.splice(0)) });
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

  it('uses only the JWT User lookup and one Article lookup during creation', async () => {
    const sql = jest.spyOn(dataSource.logger, 'logQuery');
    await post().expect(201);
    const statements = sql.mock.calls.map(([statement]) => statement);
    expect(
      statements.filter((statement) => statement.includes('FROM `users`')),
    ).toHaveLength(1);
    expect(
      statements.filter(
        (statement) =>
          statement.startsWith('SELECT ') &&
          statement.includes('FROM `articles`'),
      ),
    ).toHaveLength(1);
    expect(
      statements.filter((statement) =>
        statement.startsWith('INSERT INTO `comments`'),
      ),
    ).toHaveLength(1);
    expect(statements).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/START TRANSACTION|COMMIT/),
      ]),
    );
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
    'x' + '\n'.repeat(COMMENT_BODY_MAX_BYTES - 1),
    '"'.repeat(COMMENT_BODY_MAX_BYTES),
    '\u0000'.repeat(COMMENT_BODY_MAX_BYTES),
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
    '\u0000'.repeat(COMMENT_BODY_MAX_BYTES + 1),
  ])(
    'rejects oversized UTF-8 bodies before persistence (case %#)',
    async (body) => {
      await post({ comment: { body } }).expect(400);
      expect(await ownCount()).toBe(0);
    },
  );

  it('keeps the transport limit bounded and preserves the default limit on other routes and methods', async () => {
    await post({
      comment: { body: 'a'.repeat(COMMENT_JSON_MAX_BYTES) },
    }).expect(413);
    const payload = {
      comment: { body: 'x' + '\n'.repeat(COMMENT_BODY_MAX_BYTES - 1) },
    };
    await request(app.getHttpServer())
      .post('/api/articles')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(413);
    await get().send(payload).expect(413);
    await remove(randomUUID()).send(payload).expect(413);
    expect(await ownCount()).toBe(0);
  });

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'Application/JSON; Charset=UTF-8',
  ])(
    'accepts maximum escaped JSON with Content-Type %s',
    async (contentType) => {
      const body = '\u0000'.repeat(COMMENT_BODY_MAX_BYTES);
      await request(app.getHttpServer())
        .post(
          `/api/articles/${encodeURIComponent(article.slug)}/comments/?lang=en`,
        )
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', contentType)
        .send(JSON.stringify({ comment: { body } }))
        .expect(201);
      expect(await ownCount()).toBe(1);
    },
  );

  it.each([
    'text/plain',
    'application/vnd.api+json',
    'application/octet-stream',
  ])(
    'does not parse unsupported Content-Type %s as JSON',
    async (contentType) => {
      await request(app.getHttpServer())
        .post(`/api/articles/${encodeURIComponent(article.slug)}/comments`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', contentType)
        .send(JSON.stringify({ comment: { body: 'Text' } }))
        .expect(400);
      expect(await ownCount()).toBe(0);
    },
  );

  it.each(['comments', 'articles'])(
    'returns 400 for malformed JSON on %s',
    async (route) => {
      const path =
        route === 'comments'
          ? `/api/articles/${encodeURIComponent(article.slug)}/comments`
          : '/api/articles';
      await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"comment":')
        .expect(400);
      expect(await ownCount()).toBe(0);
    },
  );

  it.each(['v2/api', ''])(
    'preserves scoped transport limits with global prefix %j',
    async (prefix) => {
      // Passport's strategy registry is process-global. Reuse the real strategy
      // so closing this second app cannot replace the first app's live client.
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(JwtStrategy)
        .useValue(app.get(JwtStrategy))
        .compile();
      const alternate =
        moduleRef.createNestApplication<NestExpressApplication>();
      try {
        // This is the same prefix/parser configuration called by main.ts.
        configureHttpApplication(alternate, prefix);
        await alternate.init();
        expect(alternate.get(DataSource).options).toMatchObject({
          type: 'mysql',
          host: '127.0.0.1',
          port: 3308,
          database: 'nestjs_tutorial_test',
          synchronize: false,
          migrationsRun: false,
        });
        const root = prefix ? `/${prefix}` : '';
        const path = `${root}/articles/${encodeURIComponent(article.slug)}/comments`;
        for (const body of [
          '\u0000'.repeat(COMMENT_BODY_MAX_BYTES),
          '\u20ac'.repeat(21_845),
        ]) {
          const response = await request(alternate.getHttpServer())
            .post(path)
            .set('Authorization', `Bearer ${token}`)
            .send({ comment: { body } })
            .expect(201);
          const result = (response.body as CommentResponseDto).comment;
          expect(result.body).toBe(body);
          expect((await comments.findOneByOrFail({ id: result.id })).body).toBe(
            body,
          );
        }
        await request(alternate.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .send({ comment: { body: 'x'.repeat(COMMENT_JSON_MAX_BYTES) } })
          .expect(413);
        await request(alternate.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .send({ comment: { body: 'x'.repeat(COMMENT_BODY_MAX_BYTES + 1) } })
          .expect(400);
        await request(alternate.getHttpServer())
          .post(`${root}/articles`)
          .send({ comment: { body: '\u0000'.repeat(COMMENT_BODY_MAX_BYTES) } })
          .expect(413);
        expect(await ownCount()).toBe(2);
      } finally {
        await alternate.close();
      }
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

  it.each(['en', 'vi'])(
    'handles a real concurrent Article deletion with localized 404 and no extra lookup (%s)',
    async (lang) => {
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
      const sql = jest.spyOn(dataSource.logger, 'logQuery');
      const response = await post().query({ lang }).expect(404);
      expect(response.body.message).toBe(
        lang === 'vi'
          ? 'Không tìm thấy bài viết cho bình luận này'
          : 'Article not found for this comment',
      );
      const statements = sql.mock.calls.map(([statement]) => statement);
      expect(
        statements.filter(
          (statement) =>
            statement.startsWith('SELECT ') &&
            statement.includes('FROM `articles`'),
        ),
      ).toHaveLength(1);
      expect(await ownCount()).toBe(0);
      expect(await articles.existsBy({ id: article.id })).toBe(false);
      expect(await articles.existsBy({ id: unrelated.id })).toBe(true);
    },
  );

  it.each(['FK_comments_author_id', 'FK_comments_article_id_extra'])(
    'sanitizes unrelated FK %s as 500 without an Article recheck',
    async (constraint) => {
      const cause = new QueryFailedError(
        'private SQL',
        ['private body'],
        Object.assign(new Error(`CONSTRAINT \`${constraint}\` FOREIGN KEY`), {
          code: 'ER_NO_REFERENCED_ROW_2',
        }),
      );
      jest.spyOn(dataSource.manager, 'save').mockRejectedValueOnce(cause);
      const exists = jest.spyOn(dataSource.manager, 'existsBy');
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const response = await post().expect(500);
      expect(response.body.message).toBe('Unable to create the comment');
      expect(JSON.stringify(response.body)).not.toMatch(
        /private|SQL|constraint|stack/i,
      );
      expect(exists).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('Comment creation failed', {
        errorType: 'QueryFailedError',
        code: 'ER_NO_REFERENCED_ROW_2',
      });
      expect(await ownCount()).toBe(0);
      expect(await articles.findOneByOrFail({ id: article.id })).toEqual(
        article,
      );
    },
  );

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

  describe('DELETE Comment', () => {
    async function createTarget() {
      return comments.save({
        articleId: article.id,
        authorId: commenter.id,
        body: 'Author-owned comment',
      });
    }

    it('returns empty 204 and preserves parents, unrelated Comments, Article content/tags/favorites and Follow metadata', async () => {
      const target = await createTarget();
      const retained = await comments.save({
        articleId: article.id,
        authorId: owner.id,
        body: 'Retained same-article comment',
      });
      const otherComment = await comments.save({
        articleId: unrelated.id,
        authorId: commenter.id,
        body: 'Retained unrelated comment',
      });
      const tag = await dataSource
        .getRepository(Tag)
        .save({ name: `delete-${randomUUID()}` });
      tagIds.push(tag.id);
      await dataSource
        .getRepository(ArticleTag)
        .insert({ articleId: article.id, tagId: tag.id });
      await dataSource
        .getRepository(ArticleFavorite)
        .insert({ articleId: article.id, userId: commenter.id });
      await dataSource
        .getRepository(Follow)
        .insert({ followerId: commenter.id, followingId: owner.id });
      const before = await request(app.getHttpServer())
        .get(`/api/articles/${article.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const response = await remove(target.id).expect(204);
      expect(response.text).toBe('');
      expect(response.headers['content-type']).toBeUndefined();
      expect(await comments.existsBy({ id: target.id })).toBe(false);
      expect(await comments.findOneByOrFail({ id: retained.id })).toEqual(
        retained,
      );
      expect(await comments.findOneByOrFail({ id: otherComment.id })).toEqual(
        otherComment,
      );
      const listed = await get().expect(200);
      expect(listed.headers['cache-control']).toBe('private, no-store');
      expect(
        (listed.body as CommentsResponseDto).comments.map(
          (comment) => comment.id,
        ),
      ).toEqual([retained.id]);
      const after = await request(app.getHttpServer())
        .get(`/api/articles/${article.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body).toEqual(before.body);
      expect(await articles.findOneByOrFail({ id: article.id })).toEqual(
        article,
      );
      expect(await articles.findOneByOrFail({ id: unrelated.id })).toEqual(
        unrelated,
      );
      expect(await users.countBy({ id: In(userIds) })).toBe(2);
      expect(
        await dataSource
          .getRepository(ArticleTag)
          .existsBy({ articleId: article.id, tagId: tag.id }),
      ).toBe(true);
      expect(
        await dataSource
          .getRepository(ArticleFavorite)
          .existsBy({ articleId: article.id, userId: commenter.id }),
      ).toBe(true);
      expect(
        await dataSource
          .getRepository(Follow)
          .existsBy({ followerId: commenter.id, followingId: owner.id }),
      ).toBe(true);
      await request(app.getHttpServer())
        .get(`/api/profiles/${commenter.username}`)
        .expect(200);
    });

    it.each(['Article author', 'unrelated user'])(
      "rejects %s deleting another author's Comment with 403",
      async (kind) => {
        const target = await createTarget();
        let viewerId = owner.id;
        if (kind === 'unrelated user') {
          viewerId = randomUUID();
          userIds.push(viewerId);
          await users.insert({
            id: viewerId,
            username: `c_${viewerId}`,
            email: `c_${viewerId}@example.test`,
            passwordHash: INVALID_USER_PASSWORD_HASH,
          });
        }
        const credential = await app
          .get(JwtService)
          .signAsync({ sub: viewerId, jti: randomUUID() });
        const log = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        const response = await remove(target.id, `Bearer ${credential}`).expect(
          403,
        );
        expect(response.body.message).toBe(
          'Only the comment author may delete this comment',
        );
        expect(await comments.findOneByOrFail({ id: target.id })).toEqual(
          target,
        );
        expect(log).not.toHaveBeenCalled();
      },
    );

    it.each([true, false])(
      'returns 404 for cross-Article IDs before authorization (Comment author=%s)',
      async (isAuthor) => {
        const target = await comments.save({
          articleId: unrelated.id,
          authorId: commenter.id,
          body: 'Other Article',
        });
        const credential = isAuthor
          ? token
          : await app
              .get(JwtService)
              .signAsync({ sub: owner.id, jti: randomUUID() });
        await remove(target.id, `Bearer ${credential}`).expect(404);
        expect(await comments.findOneByOrFail({ id: target.id })).toEqual(
          target,
        );
      },
    );

    it('returns 404 for an unknown Article or valid nonexistent Comment UUID without mutations', async () => {
      const target = await createTarget();
      await remove(target.id, undefined, `missing-${randomUUID()}`).expect(404);
      const response = await remove(randomUUID()).expect(404);
      expect(response.body.message).toBe('Comment not found in this article');
      expect(await comments.findOneByOrFail({ id: target.id })).toEqual(target);
    });

    it('uses the current slug and returns 404 on repeated deletion', async () => {
      const target = await createTarget();
      const newSlug = `renamed-${randomUUID()}`;
      await articles.update(article.id, { slug: newSlug });
      await remove(target.id).expect(404);
      await remove(target.id, undefined, newSlug).expect(204);
      await remove(target.id, undefined, newSlug).expect(404);
    });

    it.each([
      'not-a-uuid',
      '123',
      '00000000-0000-4000-8000-00000000000Z',
      "' OR 1=1 --",
    ])(
      'rejects malformed UUIDs without invoking deletion (case %#)',
      async (id) => {
        const target = await createTarget();
        const operation = jest.spyOn(app.get(CommentsService), 'deleteComment');
        await remove(id).expect(400);
        expect(operation).not.toHaveBeenCalled();
        expect(await comments.findOneByOrFail({ id: target.id })).toEqual(
          target,
        );
      },
    );

    it('ignores body/query ownership fields and uses only the path and JWT principal, matching Delete Article', async () => {
      const target = await createTarget();
      const retained = await comments.save({
        articleId: article.id,
        authorId: owner.id,
        body: 'Retained',
      });
      const ownerToken = await app
        .get(JwtService)
        .signAsync({ sub: owner.id, jti: randomUUID() });
      await remove(target.id, `Bearer ${ownerToken}`)
        .query({ authorId: commenter.id, viewerId: commenter.id })
        .send({ authorId: commenter.id })
        .expect(403);
      await remove(target.id)
        .query({ id: retained.id, articleId: unrelated.id, authorId: owner.id })
        .send({
          commentId: retained.id,
          articleId: unrelated.id,
          authorId: owner.id,
        })
        .expect(204);
      expect(await comments.existsBy({ id: target.id })).toBe(false);
      expect(await comments.findOneByOrFail({ id: retained.id })).toEqual(
        retained,
      );
    });

    it.each([
      null,
      '',
      'Bearer',
      'Basic credentials',
      'Bearer invalid.jwt.token',
    ])(
      'rejects missing/invalid credentials before reaching deletion (case %#)',
      async (credential) => {
        const target = await createTarget();
        const operation = jest.spyOn(app.get(CommentsService), 'deleteComment');
        await remove(target.id, credential).expect(401);
        expect(operation).not.toHaveBeenCalled();
        expect(await comments.findOneByOrFail({ id: target.id })).toEqual(
          target,
        );
      },
    );

    it.each(['expired', 'incorrect signature', 'revoked'])(
      'rejects %s JWTs without deleting',
      async (kind) => {
        const target = await createTarget();
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
        const operation = jest.spyOn(app.get(CommentsService), 'deleteComment');
        await remove(target.id, `Bearer ${credential}`).expect(401);
        expect(operation).not.toHaveBeenCalled();
        expect(await comments.findOneByOrFail({ id: target.id })).toEqual(
          target,
        );
      },
    );

    it('fails closed with Redis unavailable before UUID validation or deletion', async () => {
      const target = await createTarget();
      const operation = jest.spyOn(app.get(CommentsService), 'deleteComment');
      const check = jest
        .spyOn(redis, 'get')
        .mockRejectedValue(new Error('Connection unavailable'));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await remove('malformed', null).expect(401);
      expect(check).not.toHaveBeenCalled();
      await remove(target.id).expect(503);
      expect(operation).not.toHaveBeenCalled();
      expect(await comments.findOneByOrFail({ id: target.id })).toEqual(target);
    });

    it('forces both DELETE lookups before one scoped deletion affects zero rows', async () => {
      const target = await createTarget();
      const retained = await comments.save({
        articleId: article.id,
        authorId: owner.id,
        body: 'Retained',
      });
      const otherComment = await comments.save({
        articleId: unrelated.id,
        authorId: commenter.id,
        body: 'Unrelated Article comment',
      });
      function deferred() {
        let resolve!: () => void;
        const promise = new Promise<void>((release) => {
          resolve = release;
        });
        return { promise, resolve };
      }
      const bothRead = deferred();
      const firstDeleted = deferred();
      const gates = [deferred(), deferred()];
      const observed: string[] = [];
      const affected: (number | null | undefined)[] = [];
      const scopes: unknown[] = [];
      async function bounded<T>(
        promise: Promise<T>,
        label: string,
      ): Promise<T> {
        let timeout!: ReturnType<typeof setTimeout>;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error(`Timed out waiting for ${label}`)),
                5_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
      const find = jest.spyOn(dataSource.manager, 'findOne');
      const originalFind = find.getMockImplementation()!;
      find.mockImplementation(async function (
        this: EntityManager,
        entity,
        options,
      ) {
        const result = await originalFind.call(this, entity, options);
        if (entity === Comment && result?.id === target.id) {
          const index = observed.length;
          observed.push(result.id);
          if (observed.length === 2) bothRead.resolve();
          await bounded(gates[index]!.promise, 'lookup release');
        }
        return result;
      });
      const deletion = jest.spyOn(dataSource.manager, 'delete');
      const originalDelete = deletion.getMockImplementation()!;
      deletion.mockImplementation(async function (
        this: EntityManager,
        entity,
        criteria,
      ) {
        const result = await originalDelete.call(this, entity, criteria);
        if (entity === Comment) {
          scopes.push(criteria);
          affected.push(result.affected);
          if (affected.length === 1) firstDeleted.resolve();
        }
        return result;
      });
      const pending = [remove(target.id), remove(target.id)].map((req) =>
        req
          .timeout({ response: 8_000, deadline: 10_000 })
          .then((response) => response),
      );
      try {
        await bounded(bothRead.promise, 'both Comment lookups');
        expect(observed).toEqual([target.id, target.id]);
        expect(affected).toEqual([]);
        gates[0]!.resolve();
        await bounded(firstDeleted.promise, 'first DELETE completion');
        expect(affected).toEqual([1]);
        gates[1]!.resolve();
        const responses = await Promise.all(pending);
        expect(affected).toEqual([1, 0]);
        expect(scopes).toEqual(
          Array(2).fill({
            id: target.id,
            articleId: article.id,
            authorId: commenter.id,
          }),
        );
        expect(
          responses
            .map((response) => response.status)
            .sort((left, right) => left - right),
        ).toEqual([204, 404]);
        expect(await comments.existsBy({ id: target.id })).toBe(false);
        expect(await comments.findOneByOrFail({ id: retained.id })).toEqual(
          retained,
        );
        expect(await comments.findOneByOrFail({ id: otherComment.id })).toEqual(
          otherComment,
        );
        expect(await articles.findOneByOrFail({ id: article.id })).toEqual(
          article,
        );
        expect(await articles.findOneByOrFail({ id: unrelated.id })).toEqual(
          unrelated,
        );
      } finally {
        for (const gate of gates) gate.resolve();
        await Promise.allSettled(pending);
        find.mockRestore();
        deletion.mockRestore();
      }
    }, 15_000);

    it.each(['en', 'vi'])(
      'logs and sanitizes unexpected DELETE errors (%s)',
      async (lang) => {
        const target = await createTarget();
        const cause = new QueryFailedError(
          'private SQL',
          ['private body'],
          Object.assign(new Error('private driver content'), {
            code: 'ER_BAD_FIELD_ERROR',
          }),
        );
        jest.spyOn(dataSource.manager, 'delete').mockRejectedValueOnce(cause);
        const log = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        const response = await remove(target.id).query({ lang }).expect(500);
        expect(response.body.message).toBe(
          lang === 'vi'
            ? 'Không thể xóa bình luận'
            : 'Unable to delete the comment',
        );
        expect(JSON.stringify(response.body)).not.toMatch(
          /SQL|private|stack|query|password|token|path/i,
        );
        expect(log).toHaveBeenCalledWith('Comment deletion failed', {
          errorType: 'QueryFailedError',
          code: 'ER_BAD_FIELD_ERROR',
        });
        expect(JSON.stringify(log.mock.calls)).not.toMatch(
          /SQL|private|body|password|token/i,
        );
        expect(await comments.findOneByOrFail({ id: target.id })).toEqual(
          target,
        );
      },
    );

    it('localizes expected 403 and 404 errors without logging failures', async () => {
      const target = await createTarget();
      const credential = await app
        .get(JwtService)
        .signAsync({ sub: owner.id, jti: randomUUID() });
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const forbidden = await remove(target.id, `Bearer ${credential}`)
        .query({ lang: 'vi' })
        .expect(403);
      expect(forbidden.body.message).toBe(
        'Chỉ tác giả bình luận mới có thể xóa bình luận này',
      );
      const missing = await remove(randomUUID())
        .query({ lang: 'vi' })
        .expect(404);
      expect(missing.body.message).toBe(
        'Không tìm thấy bình luận trong bài viết này',
      );
      expect(log).not.toHaveBeenCalled();
    });
  });

  it('documents implemented Comment operations with shared DTOs and optional GET auth', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as OpenAPIObject;
    const path = document.paths['/api/articles/{slug}/comments'];
    expect(path.post).toBeDefined();
    expect(path.get).toBeDefined();
    expect(path.delete).toBeUndefined();
    const deletion =
      document.paths['/api/articles/{slug}/comments/{id}'].delete!;
    expect(deletion.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(deletion.responses).sort()).toEqual([
      '204',
      '400',
      '401',
      '403',
      '404',
      '500',
      '503',
    ]);
    const response204 = deletion.responses['204'];
    expect(response204).toBeDefined();
    if (!response204 || '$ref' in response204) {
      throw new Error('Expected an inline HTTP 204 response definition');
    }
    expect(response204.content).toBeUndefined();
    expect(deletion.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'slug', in: 'path', required: true }),
        expect.objectContaining({
          name: 'id',
          in: 'path',
          required: true,
          schema: expect.objectContaining({ format: 'uuid' }),
        }),
      ]),
    );
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
      '413',
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
