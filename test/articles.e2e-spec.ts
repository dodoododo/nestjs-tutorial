import {
  INestApplication,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
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
import { ArticleResponseDto } from '../src/articles/dto/article-response.dto';
import { Article } from '../src/database/entities/article.entity';
import { ArticleTag } from '../src/database/entities/article-tag.entity';
import { ArticleFavorite } from '../src/database/entities/article-favorite.entity';
import { Follow } from '../src/database/entities/follow.entity';
import { Tag } from '../src/database/entities/tag.entity';
import { User } from '../src/database/entities/user.entity';
import {
  REDIS_CLIENT,
  REVOCATION_KEY_PREFIX,
} from '../src/redis/redis.constant';
import { RedisService } from '../src/redis/redis.service';
import { setupSwagger } from '../src/swagger';

describe('Create and get article APIs (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let users: Repository<User>;
  let articles: Repository<Article>;
  let tags: Repository<Tag>;
  let author: User;
  let viewer: User;
  let other: User;
  let token: string;
  let prefix: string;
  let sequence: number;
  const userIds: string[] = [];
  const tagNames = new Set<string>();
  const revocationKeys: string[] = [];

  function input(overrides: Record<string, unknown> = {}) {
    return {
      title: `Article ${prefix} ${++sequence}`,
      description: 'Description',
      body: '  Body\n\n  formatting  ',
      ...overrides,
    };
  }
  function tag(suffix: string) {
    const name = `${prefix}-${suffix}`;
    tagNames.add(name);
    return name;
  }
  function post(
    article: unknown,
    authorization: string | undefined = `Bearer ${token}`,
  ) {
    const req = request(app.getHttpServer()).post('/api/articles');
    if (authorization !== undefined) req.set('Authorization', authorization);
    return req.send({ article });
  }
  function get(slug: string, authorization?: string) {
    const req = request(app.getHttpServer()).get(
      `/api/articles/${encodeURIComponent(slug)}`,
    );
    if (authorization !== undefined) req.set('Authorization', authorization);
    return req;
  }
  async function create(overrides: Record<string, unknown> = {}) {
    const response = await post(input(overrides)).expect(201);
    return (response.body as ArticleResponseDto).article;
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    setupSwagger(app);
    await app.init();
    dataSource = app.get(DataSource);
    const redis = app.get<Redis>(REDIS_CLIENT);
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
    ) {
      throw new Error('Unsafe test database or Redis configuration');
    }
    users = dataSource.getRepository(User);
    articles = dataSource.getRepository(Article);
    tags = dataSource.getRepository(Tag);
  });

  beforeEach(async () => {
    prefix = randomUUID();
    sequence = 0;
    const fixtures = Array.from({ length: 3 }, (_, index) => {
      const id = randomUUID();
      userIds.push(id);
      return {
        id,
        username: `art_${index}_${prefix}`,
        email: `art_${index}_${prefix}@example.test`,
        passwordHash: INVALID_USER_PASSWORD_HASH,
        bio: null,
        image: null,
      };
    });
    [author, viewer, other] = await users.save(fixtures);
    token = await app
      .get(JwtService)
      .signAsync({ sub: author.id, jti: randomUUID() });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // Only fixtures from this test; user cascades clean articles/links/favorites.
    if (userIds.length) await users.delete({ id: In(userIds.splice(0)) });
    if (tagNames.size) {
      await tags.delete({ name: In([...tagNames]) });
      tagNames.clear();
    }
    if (revocationKeys.length)
      await app.get<Redis>(REDIS_CLIENT).del(...revocationKeys.splice(0));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates an owned article, trims fields and returns exactly the public contract', async () => {
    const payload = input({
      title: `  Đường đến ${prefix}  `,
      description: '  Description  ',
    });
    const result = await post(payload).expect(201);
    const article = (result.body as ArticleResponseDto).article;
    expect(result.body).toEqual({
      article: {
        slug: `duong-den-${prefix}`,
        title: `Đường đến ${prefix}`,
        description: 'Description',
        body: payload.body,
        tagList: [],
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        favorited: false,
        favoritesCount: 0,
        author: {
          username: author.username,
          bio: null,
          image: null,
          following: false,
        },
      },
    });
    expect(
      await articles.findOneByOrFail({ slug: article.slug }),
    ).toMatchObject({ authorId: author.id });
    expect((await get(article.slug).expect(200)).body).toEqual(result.body);
  });

  it('rejects a missing JWT', async () => {
    await request(app.getHttpServer())
      .post('/api/articles')
      .send({ article: input() })
      .expect(401);
    expect(await articles.countBy({ authorId: author.id })).toBe(0);
  });

  it.each(['post', 'get'] as const)(
    '%s rejects invalid, expired, incorrectly signed and revoked JWTs',
    async (method) => {
      const article = await create();
      const jwt = app.get(JwtService);
      const expired = await jwt.signAsync(
        { sub: author.id, jti: randomUUID() },
        { expiresIn: -1 },
      );
      const incorrect = await jwt.signAsync(
        { sub: author.id, jti: randomUUID() },
        { secret: 'different-secret-with-at-least-32-bytes' },
      );
      for (const credential of [
        '',
        'Bearer',
        'Basic credentials',
        'Bearer invalid.jwt.token',
        `Bearer ${expired}`,
        `Bearer ${incorrect}`,
      ]) {
        await (
          method === 'post'
            ? post(input(), credential)
            : get(article.slug, credential)
        ).expect(401);
      }
      const { jti } = await jwt.verifyAsync<{ jti: string }>(token);
      revocationKeys.push(`${REVOCATION_KEY_PREFIX}${jti}`);
      await request(app.getHttpServer())
        .post('/api/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      await (
        method === 'post' ? post(input()) : get(article.slug, `Bearer ${token}`)
      ).expect(401);
      expect(await articles.countBy({ authorId: author.id })).toBe(1);
    },
  );

  it.each(['post', 'get'] as const)(
    '%s fails closed when Redis is unavailable',
    async (method) => {
      const article = await create();
      jest
        .spyOn(app.get(RedisService), 'isTokenRevoked')
        .mockRejectedValueOnce(new ServiceUnavailableException());
      await (
        method === 'post' ? post(input()) : get(article.slug, `Bearer ${token}`)
      ).expect(503);
      expect(await articles.countBy({ authorId: author.id })).toBe(1);
    },
  );

  it('serves anonymous requests without Redis and returns translated 404', async () => {
    const article = await create();
    const check = jest
      .spyOn(app.get(RedisService), 'isTokenRevoked')
      .mockRejectedValue(new ServiceUnavailableException());
    await get(article.slug).expect(200);
    expect(check).not.toHaveBeenCalled();
    const missing = await request(app.getHttpServer())
      .get(`/api/articles/missing-${prefix}?lang=vi`)
      .expect(404);
    expect(missing.body.message).toBe('Không tìm thấy bài viết');
  });

  it.each([
    {},
    { title: 'title' },
    { title: ' ', description: 'Description', body: 'Body' },
    { title: 'Title', description: '\n\t', body: 'Body' },
    { title: 'Title', description: 'Description', body: ' \n\t' },
  ])('rejects missing or blank required fields (case %#)', async (payload) => {
    await post(payload).expect(400);
  });

  it('rejects unknown fields and client-assigned authors at both nesting levels', async () => {
    for (const field of ['authorId', 'author', 'slug', 'id'])
      await post(input({ [field]: other.id })).expect(400);
    await request(app.getHttpServer())
      .post('/api/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ article: input(), authorId: other.id })
      .expect(400);
    expect(await articles.countBy({ authorId: author.id })).toBe(0);
  });

  it.each([null, [], 'text'])(
    'rejects malformed article envelope %j',
    async (value) => {
      await post(value).expect(400);
    },
  );

  it.each([
    'a'.repeat(65_535),
    '€'.repeat(21_845),
    '😀'.repeat(16_383) + 'abc',
  ])('roundtrips a body at the UTF-8 boundary (case %#)', async (body) => {
    const article = await create({ body });
    expect(article.body).toBe(body);
    expect((await get(article.slug).expect(200)).body.article.body).toBe(body);
  });

  it.each([
    'a'.repeat(65_536),
    '€'.repeat(21_846),
    '😀'.repeat(16_384),
    '\ud800',
  ])('rejects oversized or malformed Unicode body (case %#)', async (body) => {
    await post(input({ body })).expect(400);
    expect(await articles.countBy({ authorId: author.id })).toBe(0);
  });

  it('normalizes and deduplicates tags including database-equivalent accents', async () => {
    const name = tag('nestjs');
    const accented = tag('café');
    const unaccented = tag('cafe');
    const article = await create({
      tagList: [
        ` ${name.toUpperCase()} `,
        name,
        accented.normalize('NFD'),
        unaccented,
      ],
    });
    expect(article.tagList).toHaveLength(2);
    expect(article.tagList).toContain(name);
    const stored = await articles.findOneByOrFail({ slug: article.slug });
    expect(
      await dataSource
        .getRepository(ArticleTag)
        .countBy({ articleId: stored.id }),
    ).toBe(2);
    expect((await get(article.slug).expect(200)).body.article.tagList).toEqual(
      article.tagList,
    );
  });

  it.each([
    null,
    'tag',
    [42],
    [null],
    [{}],
    [['tag']],
    [' '],
    ['a'.repeat(65)],
    Array(21).fill('same'),
  ])('rejects malformed or oversized tag lists (case %#)', async (tagList) => {
    await post(input({ tagList })).expect(400);
  });

  it('reuses existing tags under concurrent creation with reversed shared tag order', async () => {
    const first = tag('a');
    const second = tag('b');
    const existing = await tags.save({ name: first });
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(
          input({ tagList: index % 2 ? [first, second] : [second, first] }),
        ).expect(201),
      ),
    );
    for (const response of responses)
      expect(response.body.article.tagList).toEqual([first, second]);
    expect(await tags.countBy({ name: In([first, second]) })).toBe(2);
    expect((await tags.findOneByOrFail({ name: first })).id).toBe(existing.id);
    expect(
      await dataSource
        .getRepository(ArticleTag)
        .countBy({ tagId: existing.id }),
    ).toBe(6);
  });

  it('creates a missing shared tag concurrently without duplicate rows or links', async () => {
    const shared = tag('shared');
    await Promise.all(
      Array.from({ length: 6 }, () =>
        post(input({ tagList: [shared] })).expect(201),
      ),
    );
    expect(await tags.countBy({ name: shared })).toBe(1);
    const stored = await tags.findOneByOrFail({ name: shared });
    expect(
      await dataSource.getRepository(ArticleTag).countBy({ tagId: stored.id }),
    ).toBe(6);
  });

  it('returns 409 for equivalent slugs including concurrent creates without overwriting', async () => {
    const title = `Đường ${prefix}`;
    const responses = await Promise.all([
      post(input({ title })),
      post(input({ title: `DUONG ${prefix}!` })),
    ]);
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([201, 409]);
    expect(await articles.countBy({ authorId: author.id })).toBe(1);
    const successful = responses.find((response) => response.status === 201)!;
    expect((await get(successful.body.article.slug).expect(200)).body).toEqual(
      successful.body,
    );
  });

  it('reads favorite counts and viewer-specific favorite/follow state without join multiplication', async () => {
    const article = await create({ tagList: [tag('a'), tag('b')] });
    const stored = await articles.findOneByOrFail({ slug: article.slug });
    await dataSource.getRepository(ArticleFavorite).insert([
      { articleId: stored.id, userId: viewer.id },
      { articleId: stored.id, userId: other.id },
    ]);
    await dataSource
      .getRepository(Follow)
      .insert({ followerId: viewer.id, followingId: author.id });
    const viewerToken = await app
      .get(JwtService)
      .signAsync({ sub: viewer.id, jti: randomUUID() });
    const authenticated = await get(
      article.slug,
      `Bearer ${viewerToken}`,
    ).expect(200);
    expect(authenticated.body).toMatchObject({
      article: {
        favoritesCount: 2,
        favorited: true,
        author: { username: author.username, following: true },
      },
    });
    expect((await get(article.slug).expect(200)).body).toMatchObject({
      article: {
        favoritesCount: 2,
        favorited: false,
        author: { following: false },
      },
    });
    expect(
      (await get(article.slug, `Bearer ${token}`).expect(200)).body,
    ).toMatchObject({
      article: {
        favoritesCount: 2,
        favorited: false,
        author: { following: false },
      },
    });
  });

  it.each([Article, ArticleTag])(
    'rolls back all article and tag work after %p persistence failure',
    async (entity) => {
      const name = tag('rollback');
      const insert = jest.spyOn(EntityManager.prototype, 'insert');
      const original = insert.getMockImplementation()!;
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      insert.mockImplementation(function (this: EntityManager, target, values) {
        if (target === entity)
          return Promise.reject(
            new QueryFailedError(
              'private SQL',
              [],
              new Error('private persistence details'),
            ),
          );
        return original.call(this, target, values);
      });
      const response = await post(input({ tagList: [name] })).expect(500);
      expect(response.body.message).toBe(
        'Unable to persist or retrieve the article',
      );
      expect(JSON.stringify(response.body)).not.toMatch(
        /private|SQL|password|auth/i,
      );
      expect(await articles.countBy({ authorId: author.id })).toBe(0);
      expect(await tags.countBy({ name })).toBe(0);
      expect(log).toHaveBeenCalled();
    },
  );

  it('rolls back the article when the tag insert fails', async () => {
    const query = jest.spyOn(EntityManager.prototype, 'query');
    const original = query.getMockImplementation()!;
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    query.mockImplementation(function (
      this: EntityManager,
      sql: string,
      parameters?: unknown[],
    ) {
      if (sql.startsWith('INSERT INTO tags'))
        return Promise.reject(
          new QueryFailedError(sql, parameters, new Error('tag failure')),
        );
      return original.call(this, sql, parameters);
    });
    await post(input({ tagList: [tag('failure')] })).expect(500);
    expect(await articles.countBy({ authorId: author.id })).toBe(0);
  });

  it('documents only the two article endpoints and their DTOs', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    expect(
      Object.keys(response.body.paths).filter((path) =>
        path.startsWith('/api/articles'),
      ),
    ).toEqual(['/api/articles', '/api/articles/{slug}']);
    expect(
      response.body.paths['/api/articles'].post.responses['201'],
    ).toBeDefined();
    expect(response.body.paths['/api/articles/{slug}'].get.security).toEqual([
      {},
      { bearer: [] },
    ]);
  });
});
