import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { INVALID_USER_PASSWORD_HASH } from '../src/auth/constants/auth.constant';
import { Article } from '../src/database/entities/article.entity';
import { ArticleFavorite } from '../src/database/entities/article-favorite.entity';
import { ArticleTag } from '../src/database/entities/article-tag.entity';
import { Comment } from '../src/database/entities/comment.entity';
import { Tag } from '../src/database/entities/tag.entity';
import { User } from '../src/database/entities/user.entity';
import { REDIS_CLIENT } from '../src/redis/redis.constant';
import { expectCommentSchema } from './helpers/expect-comment-schema';

describe('Comment foundation (database e2e)', () => {
  const migrationName = 'CreateComments1795251668000';
  const maxBodyBytes = 65_535;
  let app: INestApplication;
  let dataSource: DataSource;
  let comments: Repository<Comment>;
  let users: Repository<User>;
  let articles: Repository<Article>;
  let owner: User;
  let viewer: User;
  let other: User;
  let article: Article;
  let unrelated: Article;
  const userIds: string[] = [];
  const tagIds: string[] = [];

  function values(overrides: Partial<Comment> = {}) {
    return {
      id: randomUUID(),
      articleId: article.id,
      authorId: viewer.id,
      body: '  Comment\n\nformatting  ',
      ...overrides,
    };
  }
  function history(): Promise<
    { id: number; timestamp: string; name: string }[]
  > {
    return dataSource.query(
      'SELECT id, timestamp, name FROM migrations ORDER BY id',
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    const redis = app.get<Redis>(REDIS_CLIENT);
    // No fixture writes or DDL before proving both configured services isolated.
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
      throw new Error('Unsafe comment test database or Redis configuration');
    expect(await redis.ping()).toBe('PONG');
    const [{ mode }] = (await dataSource.query(
      'SELECT @@SESSION.sql_mode AS mode',
    )) as { mode: string }[];
    expect(mode).toMatch(/STRICT_TRANS_TABLES|STRICT_ALL_TABLES/);
    // This suite never changes schema/history. Provision normal E2E migrations first.
    if (await dataSource.showMigrations())
      throw new Error(
        'Apply migrations to the guarded E2E database before testing',
      );
    comments = dataSource.getRepository(Comment);
    users = dataSource.getRepository(User);
    articles = dataSource.getRepository(Article);
  });

  beforeEach(async () => {
    const fixtures = Array.from({ length: 3 }, () => {
      const id = randomUUID();
      userIds.push(id);
      return {
        id,
        username: `comment_${id}`,
        email: `comment_${id}@example.test`,
        passwordHash: INVALID_USER_PASSWORD_HASH,
        bio: null,
        image: null,
      };
    });
    [owner, viewer, other] = await users.save(fixtures);
    [article, unrelated] = await articles.save(
      [owner, other].map((author) => {
        const id = randomUUID();
        return {
          id,
          slug: `comment-article-${id}`,
          title: 'Existing article',
          description: 'Existing description',
          body: 'Existing article body',
          authorId: author.id,
        };
      }),
    );
  });

  afterEach(async () => {
    // User cascades remove only these fixtures' articles/comments/follows/favorites.
    if (userIds.length) await users.delete({ id: In(userIds.splice(0)) });
    if (tagIds.length)
      await dataSource.getRepository(Tag).delete({ id: In(tagIds.splice(0)) });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('matches entity columns, indexes and foreign keys to the applied schema', async () => {
    expect(await dataSource.showMigrations()).toBe(false);
    expect((await history()).map((migration) => migration.name)).toContain(
      migrationName,
    );
    await expectCommentSchema(dataSource);
  });

  it('generates a UUID and timestamps, preserves formatting and loads both parent relations explicitly', async () => {
    const { id: _id, ...input } = values();
    const saved = await comments.save(input);
    expect(saved.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const stored = await comments.findOneOrFail({
      where: { id: saved.id },
      relations: { article: true, author: true },
    });
    expect(stored.body).toBe(input.body);
    expect(stored.articleId).toBe(article.id);
    expect(stored.authorId).toBe(viewer.id);
    expect(stored.article.id).toBe(article.id);
    expect(stored.author.id).toBe(viewer.id);
    expect(stored.author.passwordHash).toBeUndefined();
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(stored.updatedAt).toEqual(stored.createdAt);
    const unloaded = await comments.findOneByOrFail({ id: saved.id });
    expect(unloaded.article).toBeUndefined();
    expect(unloaded.author).toBeUndefined();
  });

  it('updates the millisecond database timestamp while preserving creation time and identity', async () => {
    const saved = await comments.save(values());
    const previous = new Date('2020-01-01T00:00:00.000Z');
    await dataSource.query('UPDATE comments SET updated_at = ? WHERE id = ?', [
      previous,
      saved.id,
    ]);
    await dataSource.query('UPDATE comments SET body = ? WHERE id = ?', [
      'Changed body',
      saved.id,
    ]);
    const stored = await comments.findOneByOrFail({ id: saved.id });
    expect(stored.createdAt).toEqual(saved.createdAt);
    expect(stored.updatedAt.getTime()).toBeGreaterThan(previous.getTime());
    expect(stored.articleId).toBe(saved.articleId);
    expect(stored.authorId).toBe(saved.authorId);
  });

  it.each(['body', 'article_id', 'author_id'])(
    'rejects a null required %s column',
    async (column) => {
      const parameters: (string | null)[] = [
        randomUUID(),
        article.id,
        viewer.id,
        'Body',
      ];
      parameters[['id', 'article_id', 'author_id', 'body'].indexOf(column)] =
        null;
      await expect(
        dataSource.query(
          'INSERT INTO comments (id, article_id, author_id, body) VALUES (?, ?, ?, ?)',
          parameters,
        ),
      ).rejects.toMatchObject({ driverError: { code: 'ER_BAD_NULL_ERROR' } });
    },
  );

  it.each(['body', 'article_id', 'author_id'])(
    'rejects an omitted required %s column',
    async (omitted) => {
      const fields = [
        ['id', randomUUID()],
        ['article_id', article.id],
        ['author_id', viewer.id],
        ['body', 'Body'],
      ].filter(([name]) => name !== omitted);
      // Identifiers come only from this fixed test-owned list; values are bound.
      await expect(
        dataSource.query(
          `INSERT INTO comments (${fields.map(([name]) => name).join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
          fields.map(([, value]) => value),
        ),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_NO_DEFAULT_FOR_FIELD' },
      });
    },
  );

  it.each(['articleId', 'authorId'] as const)(
    'rejects a nonexistent parent through %s',
    async (field) => {
      await expect(
        comments.insert(values({ [field]: randomUUID() })),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_NO_REFERENCED_ROW_2' },
      });
    },
  );

  it('enforces Comment primary key uniqueness independently of author/article pairs', async () => {
    const first = await comments.save(values());
    await expect(
      comments.insert(values({ id: first.id })),
    ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
    await comments.insert([values(), values({ articleId: unrelated.id })]);
    expect(await comments.countBy({ articleId: article.id })).toBe(2);
    expect(await comments.countBy({ authorId: viewer.id })).toBe(3);
  });

  it('looks up only the requested article and orders newest first with UUID ties', async () => {
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-01-02T00:00:00.123Z');
    const rows = [
      values({ createdAt: older }),
      values({ createdAt: newer }),
      values({ createdAt: newer }),
      values({
        articleId: unrelated.id,
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
    ];
    const expected = rows
      .filter((row) => row.articleId === article.id)
      .map((row) => ({ ...row }))
      .sort(
        (a, b) =>
          b.createdAt!.getTime() - a.createdAt!.getTime() ||
          (a.id < b.id ? 1 : -1),
      )
      .map((row) => row.id);
    await comments.insert(rows);
    const result = await comments.find({
      where: { articleId: article.id },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    expect(result.map((row) => row.id)).toEqual(expected);
    expect(result[0].createdAt.getUTCMilliseconds()).toBe(123);
  });

  it.each([
    'a'.repeat(maxBodyBytes),
    '€'.repeat(21_845),
    '😀'.repeat(16_383) + 'abc',
  ])('roundtrips exactly 65535 UTF-8 bytes (case %#)', async (body) => {
    expect(Buffer.byteLength(body, 'utf8')).toBe(maxBodyBytes);
    const saved = await comments.save(values({ body }));
    expect((await comments.findOneByOrFail({ id: saved.id })).body).toBe(body);
  });

  it.each([
    'a'.repeat(maxBodyBytes + 1),
    '€'.repeat(21_846),
    '😀'.repeat(16_384),
  ])('rejects oversized TEXT in strict SQL mode (case %#)', async (body) => {
    await expect(comments.insert(values({ body }))).rejects.toMatchObject({
      driverError: { code: 'ER_DATA_TOO_LONG' },
    });
  });

  it('leaves blank-string rejection to the future HTTP DTO rather than claiming TEXT validates content', async () => {
    await comments.insert([values({ body: '' }), values({ body: ' \n\t ' })]);
    expect(await comments.countBy({ articleId: article.id })).toBe(2);
  });

  it('cascades article deletion to its comments and links without touching another article or reusable tags', async () => {
    const removed = await comments.save(values());
    const retained = await comments.save(values({ articleId: unrelated.id }));
    const tag = await dataSource
      .getRepository(Tag)
      .save({ name: `comment_${randomUUID()}` });
    tagIds.push(tag.id);
    await dataSource.getRepository(ArticleTag).insert([
      { articleId: article.id, tagId: tag.id },
      { articleId: unrelated.id, tagId: tag.id },
    ]);
    await dataSource.getRepository(ArticleFavorite).insert([
      { articleId: article.id, userId: viewer.id },
      { articleId: unrelated.id, userId: viewer.id },
    ]);
    await articles.delete(article.id);
    expect(await comments.existsBy({ id: removed.id })).toBe(false);
    expect(await comments.findOneByOrFail({ id: retained.id })).toEqual(
      retained,
    );
    expect(
      await dataSource
        .getRepository(ArticleTag)
        .countBy({ articleId: article.id }),
    ).toBe(0);
    expect(
      await dataSource
        .getRepository(ArticleFavorite)
        .countBy({ articleId: article.id }),
    ).toBe(0);
    expect(
      await dataSource
        .getRepository(ArticleTag)
        .countBy({ articleId: unrelated.id }),
    ).toBe(1);
    expect(
      await dataSource
        .getRepository(ArticleFavorite)
        .countBy({ articleId: unrelated.id }),
    ).toBe(1);
    expect(await dataSource.getRepository(Tag).existsBy({ id: tag.id })).toBe(
      true,
    );
    expect(await users.countBy({ id: In(userIds) })).toBe(3);
  });

  it('cascades commenter deletion across articles while preserving other authors and article data', async () => {
    await comments.insert([
      values(),
      values({ articleId: unrelated.id }),
      values({ authorId: other.id }),
    ]);
    await dataSource
      .getRepository(ArticleFavorite)
      .insert({ articleId: article.id, userId: other.id });
    await users.delete(viewer.id);
    expect(await comments.countBy({ authorId: viewer.id })).toBe(0);
    expect(await comments.countBy({ authorId: other.id })).toBe(1);
    expect(await articles.findOneByOrFail({ id: article.id })).toEqual(article);
    expect(await articles.findOneByOrFail({ id: unrelated.id })).toEqual(
      unrelated,
    );
    expect(
      await dataSource
        .getRepository(ArticleFavorite)
        .countBy({ articleId: article.id, userId: other.id }),
    ).toBe(1);
  });

  it('handles both cascade paths when a deleted user also owns a commented article', async () => {
    await comments.insert([
      values({ authorId: owner.id }),
      values(),
      values({ articleId: unrelated.id, authorId: owner.id }),
      values({ articleId: unrelated.id }),
    ]);
    await users.delete(owner.id);
    expect(await articles.existsBy({ id: article.id })).toBe(false);
    expect(await comments.countBy({ articleId: article.id })).toBe(0);
    expect(await comments.countBy({ articleId: unrelated.id })).toBe(1);
    expect(
      await comments.findOneByOrFail({ articleId: unrelated.id }),
    ).toMatchObject({ authorId: viewer.id });
  });

  it('deletes one comment without deleting its parents, other comments, tags or favorites', async () => {
    const first = await comments.save(values());
    const second = await comments.save(values());
    const third = await comments.save(values({ articleId: unrelated.id }));
    const tag = await dataSource
      .getRepository(Tag)
      .save({ name: `comment_${randomUUID()}` });
    tagIds.push(tag.id);
    await dataSource
      .getRepository(ArticleTag)
      .insert({ articleId: article.id, tagId: tag.id });
    await dataSource
      .getRepository(ArticleFavorite)
      .insert({ articleId: article.id, userId: viewer.id });
    await comments.delete({
      id: first.id,
      articleId: article.id,
      authorId: viewer.id,
    });
    expect(await comments.existsBy({ id: first.id })).toBe(false);
    expect(await comments.findOneByOrFail({ id: second.id })).toEqual(second);
    expect(await comments.findOneByOrFail({ id: third.id })).toEqual(third);
    expect(await articles.findOneByOrFail({ id: article.id })).toEqual(article);
    expect(await users.existsBy({ id: viewer.id })).toBe(true);
    expect(
      await dataSource
        .getRepository(ArticleTag)
        .countBy({ articleId: article.id }),
    ).toBe(1);
    expect(
      await dataSource
        .getRepository(ArticleFavorite)
        .countBy({ articleId: article.id }),
    ).toBe(1);
  });

  it.each(['article', 'author'] as const)(
    'restricts changes to a referenced %s UUID',
    async (parent) => {
      await comments.insert(values());
      const update =
        parent === 'article'
          ? articles.update(article.id, { id: randomUUID() })
          : users.update(viewer.id, { id: randomUUID() });
      await expect(update).rejects.toMatchObject({
        driverError: { code: 'ER_ROW_IS_REFERENCED_2' },
      });
    },
  );
});
