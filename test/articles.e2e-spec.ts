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
import { ArticlesResponseDto } from '../src/articles/dto/articles-response.dto';
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
import { articleSlug } from '../src/articles/utils/article-slug.util';

describe('Article APIs (e2e)', () => {
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
  function list(query: Record<string, unknown> = {}, authorization?: string) {
    const req = request(app.getHttpServer()).get('/api/articles').query(query);
    if (authorization !== undefined) req.set('Authorization', authorization);
    return req;
  }
  async function seedList(count: number) {
    const records = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      ...input(),
      slug: `${prefix}-${index}`,
      authorId: author.id,
      // Adjacent pairs tie, so ID ordering is exercised across page boundaries.
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(index / 2))),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }));
    // TypeORM merges generated timestamp values into inserted objects. Preserve
    // the independently specified expected order before executing the insert.
    const expected = records
      .map((record) => ({ ...record }))
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.id < b.id ? 1 : -1),
      );
    await articles.insert(records);
    return expected;
  }
  async function create(overrides: Record<string, unknown> = {}) {
    const response = await post(input(overrides)).expect(201);
    return (response.body as ArticleResponseDto).article;
  }

  function mutate(
    method: 'put' | 'delete',
    slug: string,
    article: unknown = {},
    authorization: string | null = `Bearer ${token}`,
  ) {
    const req = request(app.getHttpServer())[method](
      `/api/articles/${encodeURIComponent(slug)}`,
    );
    if (authorization !== null) req.set('Authorization', authorization);
    return method === 'put' ? req.send({ article }) : req;
  }

  function authenticatedRequest(
    method: 'post' | 'get' | 'put' | 'delete' | 'list',
    slug: string,
    authorization = `Bearer ${token}`,
  ) {
    if (method === 'post') return post(input(), authorization);
    if (method === 'list') return list({}, authorization);
    if (method === 'get') return get(slug, authorization);
    return mutate(method, slug, { body: 'Changed' }, authorization);
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

  it.each(['post', 'get', 'put', 'delete', 'list'] as const)(
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
        await authenticatedRequest(method, article.slug, credential).expect(
          401,
        );
      }
      const { jti } = await jwt.verifyAsync<{ jti: string }>(token);
      revocationKeys.push(`${REVOCATION_KEY_PREFIX}${jti}`);
      await request(app.getHttpServer())
        .post('/api/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      await authenticatedRequest(method, article.slug).expect(401);
      expect(await articles.countBy({ authorId: author.id })).toBe(1);
    },
  );

  it.each(['post', 'get', 'put', 'delete', 'list'] as const)(
    '%s fails closed when Redis is unavailable',
    async (method) => {
      const article = await create();
      jest
        .spyOn(app.get(RedisService), 'isTokenRevoked')
        .mockRejectedValueOnce(new ServiceUnavailableException());
      await authenticatedRequest(method, article.slug).expect(503);
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

  describe('update and delete authorization', () => {
    it.each(['put', 'delete'] as const)(
      '%s requires authentication, ownership and an existing resource',
      async (method) => {
        const article = await create();
        const strangerToken = await app
          .get(JwtService)
          .signAsync({ sub: viewer.id, jti: randomUUID() });
        await mutate(method, article.slug, {}, null).expect(401);
        const forbidden = await mutate(
          method,
          article.slug,
          {},
          `Bearer ${strangerToken}`,
        ).expect(403);
        expect(forbidden.body.message).toBe(
          'Only the article author may modify or delete this article',
        );
        await mutate(method, `missing-${prefix}`).expect(404);
        expect((await get(article.slug).expect(200)).body.article).toEqual(
          article,
        );
      },
    );

    it('translates ownership failures', async () => {
      const article = await create();
      const strangerToken = await app
        .get(JwtService)
        .signAsync({ sub: viewer.id, jti: randomUUID() });
      const response = await request(app.getHttpServer())
        .put(`/api/articles/${article.slug}?lang=vi`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ article: {} })
        .expect(403);
      expect(response.body.message).toBe(
        'Chỉ tác giả mới có thể sửa hoặc xóa bài viết này',
      );
    });
  });

  describe('update article', () => {
    it('changes title/slug while preserving identity, ownership, tags, favorites and response metadata', async () => {
      const article = await create({ tagList: [tag('a'), tag('b')] });
      const stored = await articles.findOneByOrFail({ slug: article.slug });
      await dataSource.getRepository(ArticleFavorite).insert([
        { articleId: stored.id, userId: author.id },
        { articleId: stored.id, userId: viewer.id },
      ]);
      // Another viewer's follow must not leak into the owner's update response.
      await dataSource
        .getRepository(Follow)
        .insert({ followerId: viewer.id, followingId: author.id });
      const title = `Đường đi mới ${prefix}`;
      const response = await mutate('put', article.slug, {
        title: `  ${title}  `,
      }).expect(200);
      const updated = (response.body as ArticleResponseDto).article;
      expect(response.body).toEqual({
        article: {
          slug: `duong-di-moi-${prefix}`,
          title,
          description: article.description,
          body: article.body,
          tagList: article.tagList,
          createdAt: article.createdAt,
          updatedAt: expect.any(String),
          favoritesCount: 2,
          favorited: true,
          author: {
            username: author.username,
            bio: null,
            image: null,
            following: false,
          },
        },
      });
      expect(await articles.findOneByOrFail({ id: stored.id })).toMatchObject({
        slug: updated.slug,
        authorId: author.id,
      });
      expect(
        await dataSource
          .getRepository(ArticleTag)
          .countBy({ articleId: stored.id }),
      ).toBe(2);
      expect(
        await dataSource
          .getRepository(ArticleFavorite)
          .countBy({ articleId: stored.id }),
      ).toBe(2);
      await get(article.slug).expect(404);
      expect(
        (await get(updated.slug, `Bearer ${token}`).expect(200)).body,
      ).toEqual(response.body);
      const viewerToken = await app
        .get(JwtService)
        .signAsync({ sub: viewer.id, jti: randomUUID() });
      expect(
        (await get(updated.slug, `Bearer ${viewerToken}`).expect(200)).body
          .article.author.following,
      ).toBe(true);
    });

    it.each([
      { description: '  New description  ' },
      { body: '  New body\n\n  preserved  ' },
      { description: '  Both fields  ', body: 'Body changed too' },
      {},
    ])(
      'preserves omitted fields and handles an empty update (case %#)',
      async (changes) => {
        const article = await create();
        const stored = await articles.findOneByOrFail({ slug: article.slug });
        const result = await mutate('put', article.slug, changes).expect(200);
        expect(result.body.article).toEqual({
          slug: article.slug,
          title: article.title,
          description: changes.description?.trim() ?? article.description,
          body: changes.body ?? article.body,
          tagList: article.tagList,
          createdAt: article.createdAt,
          updatedAt: Object.keys(changes).length
            ? expect.any(String)
            : article.updatedAt,
          favorited: article.favorited,
          favoritesCount: article.favoritesCount,
          author: article.author,
        });
        expect((await articles.findOneByOrFail({ id: stored.id })).slug).toBe(
          article.slug,
        );
      },
    );

    it('updates all three fields together', async () => {
      const article = await create();
      const title = `Changed ${prefix}`;
      const result = await mutate('put', article.slug, {
        title: ` ${title} `,
        description: ' New description ',
        body: '\nNew body\n',
      }).expect(200);
      expect(result.body.article).toMatchObject({
        slug: `changed-${prefix}`,
        title,
        description: 'New description',
        body: '\nNew body\n',
      });
    });

    it('preserves a non-generated existing slug when the normalized title is unchanged', async () => {
      const article = await create();
      const customSlug = `custom-${prefix}`;
      await articles.update({ slug: article.slug }, { slug: customSlug });
      const result = await mutate('put', customSlug, {
        title: ` ${article.title} `,
      }).expect(200);
      expect(result.body.article.slug).toBe(customSlug);
    });

    it('allows the same article to keep a database-equivalent slug', async () => {
      const title = `Café ${prefix}`;
      const article = await create({ title });
      await articles.update({ slug: article.slug }, { slug: `CAFÉ-${prefix}` });
      const result = await mutate('put', `CAFÉ-${prefix}`, {
        title: `CAFE ${prefix}!`,
      }).expect(200);
      expect(result.body.article.slug).toBe(`cafe-${prefix}`);
      expect(await articles.countBy({ authorId: author.id })).toBe(1);
    });

    it('returns 409 for another database-equivalent slug without persisting other fields', async () => {
      const first = await create();
      const occupied = await create();
      await articles.update(
        { slug: occupied.slug },
        { slug: `CAFÉ-${prefix}` },
      );
      const before = await articles.findOneByOrFail({ slug: first.slug });
      await mutate('put', first.slug, {
        title: `cafe ${prefix}`,
        description: 'must roll back',
      }).expect(409);
      expect(await articles.findOneByOrFail({ id: before.id })).toEqual(before);
      expect((await get(`CAFÉ-${prefix}`).expect(200)).body.article.title).toBe(
        occupied.title,
      );
    });

    it('resolves simultaneous slug collisions through the unique index after both prechecks pass', async () => {
      const first = await create();
      const second = await create();
      const title = `Collision ${prefix}`;
      const exists = jest.spyOn(EntityManager.prototype, 'existsBy');
      const original = exists.getMockImplementation()!;
      let arrivals = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      exists.mockImplementation(async function (
        this: EntityManager,
        entity,
        where,
      ) {
        const result = await original.call(this, entity, where);
        if (entity === Article) {
          arrivals++;
          if (arrivals === 2) release();
          await barrier;
        }
        return result;
      });
      const results = await Promise.all([
        mutate('put', first.slug, { title }),
        mutate('put', second.slug, { title }),
      ]);
      expect(
        results.map((response) => response.status).sort((a, b) => a - b),
      ).toEqual([200, 409]);
      expect(arrivals).toBe(2);
      expect(await articles.countBy({ slug: articleSlug(title) })).toBe(1);
      expect(await articles.countBy({ authorId: author.id })).toBe(2);
    });

    it('serializes disjoint updates without losing omitted fields', async () => {
      const article = await create();
      await Promise.all([
        mutate('put', article.slug, {
          description: 'Description updated',
        }).expect(200),
        mutate('put', article.slug, { body: 'Body updated' }).expect(200),
      ]);
      const result = await get(article.slug).expect(200);
      expect(result.body.article).toMatchObject({
        title: article.title,
        slug: article.slug,
        description: 'Description updated',
        body: 'Body updated',
      });
    });

    it.each([
      ...['title', 'description', 'body'].flatMap((field) =>
        [null, 123, '', ' \n\t ', '\ud800'].map((value) => ({
          [field]: value,
        })),
      ),
      { title: 'a'.repeat(256) },
      { description: 'a'.repeat(1025) },
      { body: 'a'.repeat(65_536) },
      { body: '€'.repeat(21_846) },
      { body: '😀'.repeat(16_384) },
      { tagList: [] },
      { authorId: 'forged' },
      { author: {} },
      { id: 'forged' },
      { slug: 'forged' },
    ])(
      'rejects invalid or unauthorized update fields (case %#)',
      async (changes) => {
        const article = await create();
        await mutate('put', article.slug, changes).expect(400);
        expect((await get(article.slug).expect(200)).body.article).toEqual(
          article,
        );
      },
    );

    it.each([
      {},
      { article: null },
      { article: [] },
      { article: 'text' },
      { article: {}, unexpected: true },
    ])('rejects malformed update envelopes (case %#)', async (payload) => {
      const article = await create();
      await request(app.getHttpServer())
        .put(`/api/articles/${article.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .send(payload)
        .expect(400);
    });

    it.each([
      'a'.repeat(65_535),
      '€'.repeat(21_845),
      '😀'.repeat(16_383) + 'abc',
    ])('roundtrips the updated UTF-8 byte boundary (case %#)', async (body) => {
      const article = await create();
      const result = await mutate('put', article.slug, { body }).expect(200);
      expect(result.body.article.body).toBe(body);
      expect((await get(article.slug).expect(200)).body.article.body).toBe(
        body,
      );
    });

    it('rolls back an update after a persistence failure following the database write', async () => {
      const article = await create();
      const before = await articles.findOneByOrFail({ slug: article.slug });
      const update = jest.spyOn(EntityManager.prototype, 'update');
      const original = update.getMockImplementation()!;
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      update.mockImplementation(async function (
        this: EntityManager,
        target,
        criteria,
        changes,
      ) {
        const result = await original.call(this, target, criteria, changes);
        if (target === Article)
          throw new QueryFailedError(
            'private SQL',
            [],
            new Error('private update failure'),
          );
        return result;
      });
      const response = await mutate('put', article.slug, {
        title: `Rollback ${prefix}`,
        body: 'Changed',
      }).expect(500);
      expect(response.body.message).toBe(
        'Unable to persist or retrieve the article',
      );
      expect(JSON.stringify(response.body)).not.toMatch(/private|SQL|auth/i);
      expect(await articles.findOneByOrFail({ id: before.id })).toEqual(before);
      expect(log).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete article', () => {
    it('returns an empty 204, cascades links/favorites, preserves shared tags and unrelated records, then returns 404', async () => {
      const name = tag('shared-delete');
      const article = await create({ tagList: [name] });
      const retained = await create({ tagList: [name] });
      const stored = await articles.findOneByOrFail({ slug: article.slug });
      const retainedBefore = await articles.findOneByOrFail({
        slug: retained.slug,
      });
      await dataSource.getRepository(ArticleFavorite).insert([
        { articleId: stored.id, userId: viewer.id },
        { articleId: retainedBefore.id, userId: viewer.id },
      ]);
      const usersBefore = await users.find({
        where: { id: In(userIds) },
        order: { id: 'ASC' },
      });
      const response = await mutate('delete', article.slug).expect(204);
      expect(response.text).toBe('');
      expect(response.headers['content-type']).toBeUndefined();
      expect(await articles.existsBy({ id: stored.id })).toBe(false);
      expect(
        await dataSource
          .getRepository(ArticleTag)
          .countBy({ articleId: stored.id }),
      ).toBe(0);
      expect(
        await dataSource
          .getRepository(ArticleFavorite)
          .countBy({ articleId: stored.id }),
      ).toBe(0);
      expect(await tags.countBy({ name })).toBe(1);
      expect(await articles.findOneByOrFail({ id: retainedBefore.id })).toEqual(
        retainedBefore,
      );
      expect(
        await dataSource
          .getRepository(ArticleTag)
          .countBy({ articleId: retainedBefore.id }),
      ).toBe(1);
      expect(
        await dataSource
          .getRepository(ArticleFavorite)
          .countBy({ articleId: retainedBefore.id }),
      ).toBe(1);
      expect(
        await users.find({ where: { id: In(userIds) }, order: { id: 'ASC' } }),
      ).toEqual(usersBefore);
      await get(article.slug).expect(404);
      await mutate('delete', article.slug).expect(404);
    });

    it('allows exactly one simultaneous deletion', async () => {
      const article = await create();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => mutate('delete', article.slug)),
      );
      expect(
        results.map((response) => response.status).sort((a, b) => a - b),
      ).toEqual([204, 404, 404, 404, 404, 404]);
    });

    it('handles simultaneous update/delete without resurrecting an article', async () => {
      const article = await create();
      const [update, deletion] = await Promise.all([
        mutate('put', article.slug, { body: 'Changed' }),
        mutate('delete', article.slug),
      ]);
      expect([200, 404]).toContain(update.status);
      expect(deletion.status).toBe(204);
      await get(article.slug).expect(404);
    });

    it('rolls back article deletion and cascades after an unexpected persistence failure', async () => {
      const article = await create({ tagList: [tag('rollback-delete')] });
      const stored = await articles.findOneByOrFail({ slug: article.slug });
      await dataSource
        .getRepository(ArticleFavorite)
        .insert({ articleId: stored.id, userId: viewer.id });
      const deletion = jest.spyOn(EntityManager.prototype, 'delete');
      const original = deletion.getMockImplementation()!;
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      deletion.mockImplementation(async function (
        this: EntityManager,
        target,
        criteria,
      ) {
        const result = await original.call(this, target, criteria);
        if (target === Article)
          throw new QueryFailedError(
            'private SQL',
            [],
            new Error('private delete failure'),
          );
        return result;
      });
      const response = await mutate('delete', article.slug).expect(500);
      expect(response.body.message).toBe(
        'Unable to persist or retrieve the article',
      );
      expect(JSON.stringify(response.body)).not.toMatch(/private|SQL|auth/i);
      expect(await articles.findOneByOrFail({ id: stored.id })).toEqual(stored);
      expect(
        await dataSource
          .getRepository(ArticleTag)
          .countBy({ articleId: stored.id }),
      ).toBe(1);
      expect(
        await dataSource
          .getRepository(ArticleFavorite)
          .countBy({ articleId: stored.id }),
      ).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
    });
  });

  describe('List Articles', () => {
    it('returns an empty collection from an empty test database without using Redis', async () => {
      expect(await articles.count()).toBe(0);
      const revocation = jest.spyOn(app.get(RedisService), 'isTokenRevoked');
      const response = await list().expect(200);
      expect(response.body).toEqual({ articles: [], articlesCount: 0 });
      expect(revocation).not.toHaveBeenCalled();
    });

    it('defaults to 20, orders by timestamp and ID, and keeps totals on every page', async () => {
      const records = await seedList(23);
      const first = (await list().expect(200)).body as ArticlesResponseDto;
      expect(first.articlesCount).toBe(23);
      expect(first.articles.map((article) => article.slug)).toEqual(
        records.slice(0, 20).map((record) => record.slug),
      );
      const second = (await list({ offset: 20 }).expect(200))
        .body as ArticlesResponseDto;
      expect(second.articlesCount).toBe(23);
      expect(second.articles.map((article) => article.slug)).toEqual(
        records.slice(20).map((record) => record.slug),
      );
      const page = (await list({ limit: 2, offset: 1 }).expect(200))
        .body as ArticlesResponseDto;
      expect(page.articlesCount).toBe(23);
      expect(page.articles.map((article) => article.slug)).toEqual(
        records.slice(1, 3).map((record) => record.slug),
      );
      for (const offset of [23, 100, Number.MAX_SAFE_INTEGER]) {
        expect((await list({ offset }).expect(200)).body).toEqual({
          articles: [],
          articlesCount: 23,
        });
      }
      expect(
        (await list({ limit: 100 }).expect(200)).body.articles,
      ).toHaveLength(23);
      for (const article of first.articles) {
        expect(Object.keys(article).sort()).toEqual(
          [
            'slug',
            'title',
            'description',
            'tagList',
            'createdAt',
            'updatedAt',
            'favorited',
            'favoritesCount',
            'author',
          ].sort(),
        );
        expect(article.author).toEqual({
          username: author.username,
          bio: null,
          image: null,
          following: false,
        });
        expect(article.favorited).toBe(false);
      }
    });

    it('combines tag, author and another user’s favorites without duplicates or truncated tag lists', async () => {
      const records = await seedList(4);
      await articles.update(records[2].id, { authorId: other.id });
      const name = tag('café');
      const extraName = tag('extra');
      const [firstTag, extraTag] = await tags.save([
        { name },
        { name: extraName },
      ]);
      await dataSource.getRepository(ArticleTag).insert([
        { articleId: records[0].id, tagId: firstTag.id },
        { articleId: records[0].id, tagId: extraTag.id },
        { articleId: records[1].id, tagId: firstTag.id },
        { articleId: records[2].id, tagId: firstTag.id },
      ]);
      await dataSource.getRepository(ArticleFavorite).insert([
        { articleId: records[0].id, userId: viewer.id },
        { articleId: records[0].id, userId: other.id },
        { articleId: records[2].id, userId: viewer.id },
        { articleId: records[3].id, userId: viewer.id },
      ]);
      const byTag = (
        await list({ tag: ` ${name.toUpperCase().replace('É', 'E')} ` }).expect(
          200,
        )
      ).body as ArticlesResponseDto;
      expect(byTag.articlesCount).toBe(3);
      expect(byTag.articles.map((article) => article.slug)).toEqual(
        records.slice(0, 3).map((record) => record.slug),
      );
      expect(byTag.articles[0].tagList.sort()).toEqual(
        [name, extraName].sort(),
      );
      expect(byTag.articles[0].favoritesCount).toBe(2);
      const byAuthor = (
        await list({ author: ` ${author.username.toUpperCase()} ` }).expect(200)
      ).body as ArticlesResponseDto;
      expect(byAuthor.articles.map((article) => article.slug)).toEqual(
        [records[0], records[1], records[3]].map((record) => record.slug),
      );
      const byFavorite = (
        await list({ favorited: ` ${viewer.username.toUpperCase()} ` }).expect(
          200,
        )
      ).body as ArticlesResponseDto;
      expect(byFavorite.articles.map((article) => article.slug)).toEqual(
        [records[0], records[2], records[3]].map((record) => record.slug),
      );
      const combined = {
        tag: name,
        author: author.username,
        favorited: viewer.username,
      };
      const result = (await list(combined, `Bearer ${token}`).expect(200))
        .body as ArticlesResponseDto;
      expect(result.articlesCount).toBe(1);
      expect(result.articles[0]).toMatchObject({
        slug: records[0].slug,
        favoritesCount: 2,
        favorited: false,
      });
      expect((await list({ ...combined, offset: 1 }).expect(200)).body).toEqual(
        { articles: [], articlesCount: 1 },
      );
      const filteredPage = (
        await list({ tag: name, limit: 1, offset: 1 }).expect(200)
      ).body as ArticlesResponseDto;
      expect(filteredPage.articlesCount).toBe(3);
      expect(filteredPage.articles.map((article) => article.slug)).toEqual([
        records[1].slug,
      ]);
      for (const query of [
        { author: 'missing-user' },
        { favorited: 'missing-user' },
        { tag: 'missing-tag' },
        { tag: "x' OR 1=1 --" },
        { author: "x' OR 1=1 --" },
      ]) {
        expect((await list(query).expect(200)).body).toEqual({
          articles: [],
          articlesCount: 0,
        });
      }
    });

    it('returns batch metadata for a viewer across followed/unfollowed authors and favorited/unfavorited articles', async () => {
      const records = await seedList(3);
      await articles.update(records[1].id, { authorId: other.id });
      await dataSource.getRepository(ArticleFavorite).insert([
        { articleId: records[0].id, userId: viewer.id },
        { articleId: records[0].id, userId: other.id },
        { articleId: records[1].id, userId: viewer.id },
      ]);
      await dataSource
        .getRepository(Follow)
        .insert({ followerId: viewer.id, followingId: author.id });
      const viewerToken = await app
        .get(JwtService)
        .signAsync({ sub: viewer.id, jti: randomUUID() });
      const response = (await list({}, `Bearer ${viewerToken}`).expect(200))
        .body as ArticlesResponseDto;
      expect(
        response.articles.map((article) => [
          article.favoritesCount,
          article.favorited,
          article.author.following,
        ]),
      ).toEqual([
        [2, true, true],
        [1, true, false],
        [0, false, true],
      ]);
      const anonymous = (await list().expect(200)).body as ArticlesResponseDto;
      expect(
        anonymous.articles.map((article) => article.favoritesCount),
      ).toEqual([2, 1, 0]);
      expect(
        anonymous.articles.every(
          (article) => !article.favorited && !article.author.following,
        ),
      ).toBe(true);
    });

    it.each([
      'limit=-1',
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=1.0',
      'limit=NaN',
      'limit=Infinity',
      'limit=1x',
      'limit=1e2',
      'limit=0x10',
      'limit=',
      'limit=%20',
      'limit=1%0A',
      'offset=-1',
      'offset=1.5',
      'offset=NaN',
      'offset=Infinity',
      'offset=9007199254740992',
      'offset=',
      'offset=1%0A',
      'limit=1&limit=2',
      'offset=0&offset=1',
      'tag=a&tag=b',
      'author=alice&author=bob',
      'favorited=alice&favorited=bob',
      'limit[]=1',
      'offset[value]=0',
      'tag[]=nestjs',
      'author[value]=alice',
      'favorited[]=alice',
      'tag=',
      'tag=%20',
      'author=',
      'author=ab',
      'favorited=',
      'favorited=ab',
      'unknown=x',
      `tag=${'x'.repeat(65)}`,
      `author=${'x'.repeat(51)}`,
      `favorited=${'x'.repeat(51)}`,
    ])('rejects malformed query %s', async (query) => {
      await request(app.getHttpServer())
        .get(`/api/articles?${query}`)
        .expect(400);
    });

    it('uses a fixed SQL query count as page size grows and never selects article body', async () => {
      const records = await seedList(21);
      const names = [tag('one'), tag('two')];
      const storedTags = await tags.save(names.map((name) => ({ name })));
      await dataSource.getRepository(ArticleTag).insert(
        records.flatMap((article) =>
          storedTags.map((storedTag) => ({
            articleId: article.id,
            tagId: storedTag.id,
          })),
        ),
      );
      const sql = jest.spyOn(dataSource.logger, 'logQuery');
      for (const limit of [1, 20]) {
        sql.mockClear();
        const response = (await list({ limit }).expect(200))
          .body as ArticlesResponseDto;
        expect(response.articles).toHaveLength(limit);
        expect(
          response.articles.every((article) => article.tagList.length === 2),
        ).toBe(true);
        expect(sql).toHaveBeenCalledTimes(3); // count, page with metadata, all page tags
        const statements = sql.mock.calls.map(([query]) => query);
        expect(statements.join('\n')).not.toMatch(
          /`body`|`email`|`password_hash`/,
        );
        expect(statements[1]).toContain('favoritesCount');
        expect(statements[2]).toContain(' IN (');
        sql.mockClear();
        await list({ limit }, `Bearer ${token}`).expect(200);
        expect(sql).toHaveBeenCalledTimes(4); // JWT strategy adds one user lookup
        expect(
          sql.mock.calls.filter(
            ([query]) =>
              query.includes(' AS `favorited`') &&
              query.includes(' AS `following`'),
          ),
        ).toHaveLength(1);
      }
    });
  });

  it('documents only the five article operations and their DTOs', async () => {
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
    const collection = response.body.paths['/api/articles'];
    expect(Object.keys(collection).sort()).toEqual(['get', 'post']);
    expect(collection.get.security).toEqual([{}, { bearer: [] }]);
    expect(
      collection.get.parameters
        .map((parameter: { name: string }) => parameter.name)
        .sort(),
    ).toEqual(['author', 'favorited', 'limit', 'offset', 'tag']);
    expect(
      collection.get.parameters.find(
        (parameter: { name: string }) => parameter.name === 'limit',
      ).schema,
    ).toMatchObject({ default: 20, minimum: 1, maximum: 100 });
    expect(
      response.body.components.schemas.ArticlesResponseDto.properties.articles
        .items.$ref,
    ).toBe('#/components/schemas/ArticleSummaryDto');
    expect(
      response.body.components.schemas.ArticleSummaryDto.properties.body,
    ).toBeUndefined();
    expect(response.body.paths['/api/articles/{slug}'].get.security).toEqual([
      {},
      { bearer: [] },
    ]);
    expect(
      Object.keys(response.body.paths['/api/articles/{slug}']).sort(),
    ).toEqual(['delete', 'get', 'put']);
    expect(response.body.paths['/api/articles/{slug}'].put.security).toEqual([
      { bearer: [] },
    ]);
    expect(
      response.body.paths['/api/articles/{slug}'].delete.responses['204'],
    ).toBeDefined();
    expect(
      response.body.paths['/api/articles/{slug}'].delete.responses['204']
        .content,
    ).toBeUndefined();
    const updateSchema = response.body.components.schemas.UpdateArticleDto;
    expect(Object.keys(updateSchema.properties).sort()).toEqual([
      'body',
      'description',
      'title',
    ]);
    expect(updateSchema.required ?? []).toEqual([]);
  });
});
