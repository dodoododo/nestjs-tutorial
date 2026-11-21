import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { INVALID_USER_PASSWORD_HASH } from '../src/auth/constants/auth.constant';
import { Article } from '../src/database/entities/article.entity';
import { ArticleFavorite } from '../src/database/entities/article-favorite.entity';
import { ArticleTag } from '../src/database/entities/article-tag.entity';
import { Attachment } from '../src/database/entities/attachment.entity';
import { Comment } from '../src/database/entities/comment.entity';
import { Follow } from '../src/database/entities/follow.entity';
import { Tag } from '../src/database/entities/tag.entity';
import { User } from '../src/database/entities/user.entity';
import { REDIS_CLIENT } from '../src/redis/redis.constant';

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
  const attachmentIds: string[] = [];

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
    const executed = new Set(
      (await history()).map((migration) => migration.name),
    );
    const pending = dataSource.migrations.filter(
      (migration) =>
        !executed.has(migration.name ?? migration.constructor.name),
    );
    if (
      pending.some(
        (migration) =>
          (migration.name ?? migration.constructor.name) !== migrationName,
      )
    ) {
      throw new Error(
        'Apply historical migrations to the isolated test database first',
      );
    }
    // This suite can set up only its new migration; never repair/reset old data.
    const applied = await dataSource.runMigrations({ transaction: 'none' });
    expect(applied.map((migration) => migration.name)).toEqual(
      pending.length ? [migrationName] : [],
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
    if (attachmentIds.length)
      await dataSource
        .getRepository(Attachment)
        .delete({ id: In(attachmentIds.splice(0)) });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('matches entity columns, indexes and foreign keys to the applied schema', async () => {
    expect(await dataSource.showMigrations()).toBe(false);
    expect((await history()).at(-1)?.name).toBe(migrationName);
    const runner = dataSource.createQueryRunner();
    try {
      const table = (await runner.getTable('comments'))!;
      const metadata = dataSource.getMetadata(Comment);
      expect(table).toBeDefined();
      const columns = [
        'id',
        'article_id',
        'author_id',
        'body',
        'created_at',
        'updated_at',
      ];
      expect(table.columns.map((column) => column.name).sort()).toEqual(
        [...columns].sort(),
      );
      expect(
        metadata.columns.map((column) => column.databaseName).sort(),
      ).toEqual([...columns].sort());
      expect(table.columns.every((column) => !column.isNullable)).toBe(true);
      expect(table.primaryColumns.map((column) => column.name)).toEqual(['id']);
      expect(
        metadata.primaryColumns.map((column) => column.databaseName),
      ).toEqual(['id']);
      expect(
        metadata.generatedColumns.map((column) => [
          column.databaseName,
          column.generationStrategy,
        ]),
      ).toEqual([['id', 'uuid']]);
      for (const name of ['id', 'article_id', 'author_id'])
        expect(table.findColumnByName(name)).toMatchObject({
          type: 'varchar',
          length: '36',
          isNullable: false,
        });
      expect(table.findColumnByName('body')).toMatchObject({
        type: 'text',
        isNullable: false,
      });
      for (const name of ['created_at', 'updated_at']) {
        const column = table.findColumnByName(name)!;
        expect(column).toMatchObject({
          type: 'datetime',
          precision: 3,
          isNullable: false,
        });
        expect(String(column.default).toUpperCase()).toContain(
          'CURRENT_TIMESTAMP(3)',
        );
      }
      expect(
        table.findColumnByName('updated_at')!.onUpdate?.toUpperCase(),
      ).toBe('CURRENT_TIMESTAMP(3)');
      const expectedIndexes = [
        {
          name: 'IDX_comments_article_created_at_id',
          columnNames: ['article_id', 'created_at', 'id'],
          isUnique: false,
        },
        {
          name: 'IDX_comments_author_id',
          columnNames: ['author_id'],
          isUnique: false,
        },
      ];
      expect(table.indices).toHaveLength(expectedIndexes.length);
      for (const index of expectedIndexes) {
        expect(table.indices).toContainEqual(expect.objectContaining(index));
        expect(
          metadata.indices.map((entry) => ({
            name: entry.name,
            columnNames: entry.columns.map((column) => column.databaseName),
            isUnique: entry.isUnique,
          })),
        ).toContainEqual(index);
      }
      expect(table.foreignKeys).toHaveLength(2);
      for (const [column, parent] of [
        ['article_id', 'articles'],
        ['author_id', 'users'],
      ]) {
        expect(table.foreignKeys).toContainEqual(
          expect.objectContaining({
            name: `FK_comments_${column}`,
            columnNames: [column],
            referencedTableName: parent,
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
          }),
        );
      }
      expect(
        metadata.relations.map((relation) => relation.propertyName).sort(),
      ).toEqual(['article', 'author']);
      for (const relation of metadata.relations) {
        expect(relation.relationType).toBe('many-to-one');
        expect(relation.isEager).toBe(false);
        expect(relation.isCascadeInsert).toBe(false);
        expect(relation.isCascadeUpdate).toBe(false);
        expect(relation.isCascadeRemove).toBe(false);
      }
      const articleTable = (await runner.getTable('articles'))!;
      expect(
        articleTable.columns.some((column) => /comment/i.test(column.name)),
      ).toBe(false);
      expect(
        dataSource
          .getMetadata(Article)
          .relations.some(
            (relation) => relation.inverseEntityMetadata.target === Comment,
          ),
      ).toBe(false);
      expect(
        dataSource
          .getMetadata(User)
          .relations.some(
            (relation) => relation.inverseEntityMetadata.target === Comment,
          ),
      ).toBe(false);
    } finally {
      await runner.release();
    }
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

  it('reverts, reapplies and repeats Comments migration without changing PR2/PR3/PR4 rows or schemas', async () => {
    if ((await comments.count()) !== 0)
      throw new Error(
        'Refusing Comments migration roundtrip: comments is nonempty',
      );
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
    await dataSource
      .getRepository(Follow)
      .insert({ followerId: viewer.id, followingId: owner.id });
    const attachmentId = randomUUID();
    attachmentIds.push(attachmentId);
    await dataSource
      .getRepository(Attachment)
      .insert({
        id: attachmentId,
        attachableType: 'user',
        attachableId: owner.id,
        url: '/existing-avatar.png',
        fileName: 'existing-avatar.png',
        fileType: 'image/png',
        fileSize: '9007199254740993',
      });
    const previous = [
      ['users', 'id'],
      ['follows', 'id'],
      ['attachments', 'id'],
      ['articles', 'id'],
      ['tags', 'id'],
      ['article_tags', 'article_id, tag_id'],
      ['article_favorites', 'user_id, article_id'],
    ];
    const digest = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const snapshot = async () => {
      const result: Record<string, { rows: string; schema: string }> = {};
      for (const [table, order] of previous)
        result[table] = {
          rows: digest(
            await dataSource.query(`SELECT * FROM ${table} ORDER BY ${order}`),
          ),
          schema: digest(await dataSource.query(`SHOW CREATE TABLE ${table}`)),
        };
      return result;
    };
    const before = await snapshot();
    const beforeHistory = await history();
    expect(beforeHistory.at(-1)?.name).toBe(migrationName);
    const runner = dataSource.createQueryRunner();
    try {
      await dataSource.undoLastMigration({ transaction: 'none' });
      expect(await runner.hasTable('comments')).toBe(false);
      expect(await snapshot()).toEqual(before);
      expect(await history()).toEqual(beforeHistory.slice(0, -1));
      const applied = await dataSource.runMigrations({ transaction: 'none' });
      expect(applied.map((migration) => migration.name)).toEqual([
        migrationName,
      ]);
      expect(await runner.hasTable('comments')).toBe(true);
      expect(await snapshot()).toEqual(before);
      const afterHistory = await history();
      expect(afterHistory.slice(0, -1)).toEqual(beforeHistory.slice(0, -1));
      expect(afterHistory.at(-1)).toMatchObject({
        name: migrationName,
        timestamp: beforeHistory.at(-1)!.timestamp,
      });
      expect(await dataSource.runMigrations({ transaction: 'none' })).toEqual(
        [],
      );
      expect(await history()).toEqual(afterHistory);
      expect(await dataSource.showMigrations()).toBe(false);
      const saved = await comments.save(values());
      expect(await comments.findOneByOrFail({ id: saved.id })).toMatchObject({
        body: saved.body,
        authorId: viewer.id,
        articleId: article.id,
      });
    } finally {
      try {
        await dataSource.runMigrations({ transaction: 'none' });
      } finally {
        await runner.release();
      }
    }
  }, 30_000);
});
