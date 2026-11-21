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
} from 'typeorm';
import { AppModule } from '../src/app.module';
import { INVALID_USER_PASSWORD_HASH } from '../src/auth/constants/auth.constant';
import { CommentResponseDto } from '../src/comments/dto/comment-response.dto';
import { COMMENT_BODY_MAX_BYTES } from '../src/comments/constants/comment.constant';
import { Article } from '../src/database/entities/article.entity';
import { Comment } from '../src/database/entities/comment.entity';
import { User } from '../src/database/entities/user.entity';
import {
  REDIS_CLIENT,
  REVOCATION_KEY_PREFIX,
} from '../src/redis/redis.constant';
import { setupSwagger } from '../src/swagger';

describe('Add Comment (e2e)', () => {
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

  it('documents only the implemented POST route with nested schemas, auth and response statuses', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as OpenAPIObject;
    const path = document.paths['/api/articles/{slug}/comments'];
    expect(path.post).toBeDefined();
    expect(path.get).toBeUndefined();
    expect(path.delete).toBeUndefined();
    expect(path.post!.security).toEqual([{ bearer: [] }]);
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
