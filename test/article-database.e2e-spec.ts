import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import {
  ARTICLE_BODY_MAX_BYTES,
  ARTICLE_DESCRIPTION_MAX_LENGTH,
  ARTICLE_SLUG_MAX_LENGTH,
  ARTICLE_TITLE_MAX_LENGTH,
  TAG_NAME_MAX_LENGTH,
} from '../src/articles/constants/article.constant';
import { INVALID_USER_PASSWORD_HASH } from '../src/auth/constants/auth.constant';
import { ArticleFavorite } from '../src/database/entities/article-favorite.entity';
import { ArticleTag } from '../src/database/entities/article-tag.entity';
import { Article } from '../src/database/entities/article.entity';
import { Attachment } from '../src/database/entities/attachment.entity';
import { Follow } from '../src/database/entities/follow.entity';
import { Tag } from '../src/database/entities/tag.entity';
import { User } from '../src/database/entities/user.entity';

describe('Article foundation (database e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let articles: Repository<Article>;
  let tags: Repository<Tag>;
  let links: Repository<ArticleTag>;
  let favorites: Repository<ArticleFavorite>;
  let users: Repository<User>;
  let author: User;
  let viewer: User;
  let other: User;
  const articleIds: string[] = [];
  const tagIds: string[] = [];
  const userIds: string[] = [];
  const attachmentIds: string[] = [];
  const newTables = ['articles', 'tags', 'article_tags', 'article_favorites'];

  function articleValues(overrides: Partial<Article> = {}) {
    const id = randomUUID();
    articleIds.push(id);
    return {
      id,
      slug: `article-${id}`,
      title: 'Article title',
      description: 'Article description',
      body: 'Article body',
      authorId: author.id,
      ...overrides,
    };
  }

  async function createArticle(overrides: Partial<Article> = {}) {
    return articles.save(articleValues(overrides));
  }

  async function createTag() {
    const id = randomUUID();
    tagIds.push(id);
    return tags.save({ id, name: `tag_${id}` });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    // Guard all fixture writes and destructive migration verification.
    if (
      process.env.NODE_ENV !== 'test' ||
      dataSource.options.type !== 'mysql' ||
      dataSource.options.host !== '127.0.0.1' ||
      dataSource.options.port !== 3308 ||
      dataSource.options.database !== 'nestjs_tutorial_test' ||
      dataSource.options.synchronize !== false ||
      dataSource.options.migrationsRun !== false
    ) {
      throw new Error('Unsafe test database configuration');
    }
    articles = dataSource.getRepository(Article);
    tags = dataSource.getRepository(Tag);
    links = dataSource.getRepository(ArticleTag);
    favorites = dataSource.getRepository(ArticleFavorite);
    users = dataSource.getRepository(User);
  });

  beforeEach(async () => {
    const fixtures = Array.from({ length: 3 }, () => {
      const id = randomUUID();
      userIds.push(id);
      return users.create({
        id,
        username: `article_${id}`,
        email: `article_${id}@example.test`,
        passwordHash: INVALID_USER_PASSWORD_HASH,
        bio: 'Existing profile',
        image: '/existing-avatar.png',
      });
    });
    [author, viewer, other] = await users.save(fixtures);
  });

  afterEach(async () => {
    if (articleIds.length) {
      await articles.delete({ id: In(articleIds) });
      articleIds.length = 0;
    }
    if (tagIds.length) {
      await tags.delete({ id: In(tagIds) });
      tagIds.length = 0;
    }
    if (attachmentIds.length) {
      await dataSource
        .getRepository(Attachment)
        .delete({ id: In(attachmentIds) });
      attachmentIds.length = 0;
    }
    if (userIds.length) {
      await users.delete({ id: In(userIds) });
      userIds.length = 0;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('matches the four entity schemas, indexes and foreign keys to the migration', async () => {
    const expected = [
      {
        entity: Article,
        table: 'articles',
        primary: ['id'],
        columns: {
          id: 36,
          slug: ARTICLE_SLUG_MAX_LENGTH,
          title: ARTICLE_TITLE_MAX_LENGTH,
          description: ARTICLE_DESCRIPTION_MAX_LENGTH,
          author_id: 36,
        },
        indexes: [
          ['IDX_articles_slug_unique', ['slug'], true],
          ['IDX_articles_created_at_id', ['created_at', 'id'], false],
          [
            'IDX_articles_author_created_at_id',
            ['author_id', 'created_at', 'id'],
            false,
          ],
        ],
        references: [['FK_articles_author_id', 'author_id', 'users']],
      },
      {
        entity: Tag,
        table: 'tags',
        primary: ['id'],
        columns: { id: 36, name: TAG_NAME_MAX_LENGTH },
        indexes: [['IDX_tags_name_unique', ['name'], true]],
        references: [],
      },
      {
        entity: ArticleTag,
        table: 'article_tags',
        primary: ['article_id', 'tag_id'],
        columns: { article_id: 36, tag_id: 36 },
        indexes: [
          ['IDX_article_tags_tag_article', ['tag_id', 'article_id'], false],
        ],
        references: [
          ['FK_article_tags_article_id', 'article_id', 'articles'],
          ['FK_article_tags_tag_id', 'tag_id', 'tags'],
        ],
      },
      {
        entity: ArticleFavorite,
        table: 'article_favorites',
        primary: ['user_id', 'article_id'],
        columns: { user_id: 36, article_id: 36 },
        indexes: [
          [
            'IDX_article_favorites_article_user',
            ['article_id', 'user_id'],
            false,
          ],
        ],
        references: [
          ['FK_article_favorites_user_id', 'user_id', 'users'],
          ['FK_article_favorites_article_id', 'article_id', 'articles'],
        ],
      },
    ];
    const runner = dataSource.createQueryRunner();
    try {
      for (const schema of expected) {
        const table = (await runner.getTable(schema.table))!;
        const metadata = dataSource.getMetadata(schema.entity);
        expect(table).toBeDefined();
        expect(table.columns.every((column) => !column.isNullable)).toBe(true);
        expect(
          table.primaryColumns.map((column) => column.name).sort(),
        ).toEqual([...schema.primary].sort());
        // TypeORM's table columns need not be returned in physical key order.
        // Check the index sequence itself, since its leftmost prefix matters.
        const primary = (await dataSource.query(
          "SELECT COLUMN_NAME AS column_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX",
          [schema.table],
        )) as { column_name: string }[];
        expect(primary.map((column) => column.column_name)).toEqual(
          schema.primary,
        );
        expect(
          metadata.primaryColumns.map((column) => column.databaseName),
        ).toEqual(schema.primary);
        expect(table.columns.map((column) => column.name).sort()).toEqual(
          metadata.columns.map((column) => column.databaseName).sort(),
        );
        for (const [name, length] of Object.entries(schema.columns)) {
          expect(table.findColumnByName(name)).toMatchObject({
            type: 'varchar',
            length: String(length),
            isNullable: false,
          });
        }
        for (const [name, columns, unique] of schema.indexes) {
          expect(table.indices).toContainEqual(
            expect.objectContaining({
              name,
              columnNames: columns,
              isUnique: unique,
            }),
          );
          expect(
            metadata.indices.map((index) => ({
              name: index.name,
              columnNames: index.columns.map((column) => column.databaseName),
              isUnique: index.isUnique,
            })),
          ).toContainEqual({ name, columnNames: columns, isUnique: unique });
        }
        expect(table.foreignKeys).toHaveLength(schema.references.length);
        for (const [name, column, parent] of schema.references) {
          expect(table.foreignKeys).toContainEqual(
            expect.objectContaining({
              name,
              columnNames: [column],
              referencedTableName: parent,
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
              onUpdate: 'RESTRICT',
            }),
          );
        }
        for (const relation of metadata.relations) {
          expect(relation.isCascadeInsert).toBe(false);
          expect(relation.isCascadeUpdate).toBe(false);
          expect(relation.isEager).toBe(false);
        }
      }
      const table = (await runner.getTable('articles'))!;
      expect(table.findColumnByName('body')).toMatchObject({
        type: 'text',
        isNullable: false,
      });
      for (const name of ['created_at', 'updated_at']) {
        expect(table.findColumnByName(name)).toMatchObject({
          type: 'datetime',
          precision: 3,
          isNullable: false,
        });
      }
      expect(
        table.findColumnByName('updated_at')!.onUpdate?.toUpperCase(),
      ).toBe('CURRENT_TIMESTAMP(3)');
    } finally {
      await runner.release();
    }
  });

  it('persists an article with a generated UUID, timestamps and a real author relation', async () => {
    const { id: _id, ...values } = articleValues();
    const saved = await articles.save(values);
    articleIds.push(saved.id);
    expect(saved.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const stored = await articles.findOneOrFail({
      where: { id: saved.id },
      relations: { author: true },
    });
    expect(stored).toMatchObject(values);
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(stored.updatedAt).toEqual(stored.createdAt);
    expect(stored.author.id).toBe(author.id);
    expect(stored.author.passwordHash).toBeUndefined();
  });

  it('updates the database timestamp while preserving creation time and identity', async () => {
    const saved = await createArticle();
    const previous = new Date('2020-01-01T00:00:00.000Z');
    // A fixed historical value avoids sleeps and millisecond-clock races.
    await dataSource.query('UPDATE articles SET updated_at = ? WHERE id = ?', [
      previous,
      saved.id,
    ]);
    await dataSource.query('UPDATE articles SET title = ? WHERE id = ?', [
      'Changed title',
      saved.id,
    ]);
    const stored = await articles.findOneByOrFail({ id: saved.id });
    expect(stored.createdAt).toEqual(saved.createdAt);
    expect(stored.updatedAt.getTime()).toBeGreaterThan(previous.getTime());
    expect(stored.slug).toBe(saved.slug);
  });

  it('enforces unique slugs without preventing duplicate titles', async () => {
    const first = await createArticle();
    await expect(
      articles.insert(articleValues({ slug: first.slug })),
    ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
    await expect(createArticle({ title: first.title })).resolves.toMatchObject({
      title: first.title,
    });
  });

  it.each(['slug', 'title', 'description', 'body', 'author_id'])(
    'rejects null article %s',
    async (column) => {
      const values = articleValues();
      const columns = [
        'id',
        'slug',
        'title',
        'description',
        'body',
        'author_id',
      ];
      const parameters: (string | null)[] = [
        values.id,
        values.slug,
        values.title,
        values.description,
        values.body,
        values.authorId,
      ];
      parameters[columns.indexOf(column)] = null;
      await expect(
        dataSource.query(
          'INSERT INTO articles (id, slug, title, description, body, author_id) VALUES (?, ?, ?, ?, ?, ?)',
          parameters,
        ),
      ).rejects.toMatchObject({ driverError: { code: 'ER_BAD_NULL_ERROR' } });
    },
  );

  it('rejects articles with omitted required fields', async () => {
    const id = randomUUID();
    articleIds.push(id);
    await expect(
      dataSource.query('INSERT INTO articles (id) VALUES (?)', [id]),
    ).rejects.toMatchObject({
      driverError: { code: 'ER_NO_DEFAULT_FOR_FIELD' },
    });
  });

  it.each([
    { slug: 'a'.repeat(ARTICLE_SLUG_MAX_LENGTH + 1) },
    { title: 'a'.repeat(ARTICLE_TITLE_MAX_LENGTH + 1) },
    { description: 'a'.repeat(ARTICLE_DESCRIPTION_MAX_LENGTH + 1) },
  ])('rejects oversized varchar article fields (case %#)', async (fields) => {
    await expect(createArticle(fields)).rejects.toMatchObject({
      driverError: { code: 'ER_DATA_TOO_LONG' },
    });
  });

  it.each([
    'a'.repeat(ARTICLE_BODY_MAX_BYTES),
    '\u20ac'.repeat(ARTICLE_BODY_MAX_BYTES / 3),
  ])('roundtrips a body at the TEXT byte boundary (case %#)', async (body) => {
    expect(Buffer.byteLength(body, 'utf8')).toBe(ARTICLE_BODY_MAX_BYTES);
    const saved = await createArticle({ body });
    expect((await articles.findOneByOrFail({ id: saved.id })).body).toBe(body);
  });

  it.each(['a'.repeat(ARTICLE_BODY_MAX_BYTES + 1), '\u20ac'.repeat(21_846)])(
    'rejects a body beyond the TEXT byte boundary in strict SQL mode (case %#)',
    async (body) => {
      await expect(createArticle({ body })).rejects.toMatchObject({
        driverError: { code: 'ER_DATA_TOO_LONG' },
      });
    },
  );

  it('rejects an article referencing a nonexistent author', async () => {
    await expect(
      createArticle({ authorId: randomUUID() }),
    ).rejects.toMatchObject({
      driverError: { code: 'ER_NO_REFERENCED_ROW_2' },
    });
  });

  it('enforces tag name uniqueness and column requirements', async () => {
    const tag = await createTag();
    await expect(tags.insert({ name: tag.name })).rejects.toMatchObject({
      driverError: { code: 'ER_DUP_ENTRY' },
    });
    await expect(
      tags.insert({ name: tag.name.toUpperCase() }),
    ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
    await expect(
      tags.insert({ name: 'a'.repeat(TAG_NAME_MAX_LENGTH + 1) }),
    ).rejects.toMatchObject({ driverError: { code: 'ER_DATA_TOO_LONG' } });
    await expect(
      dataSource.query('INSERT INTO tags (id, name) VALUES (?, ?)', [
        randomUUID(),
        null,
      ]),
    ).rejects.toMatchObject({ driverError: { code: 'ER_BAD_NULL_ERROR' } });
  });

  it('reuses tags across articles and prevents duplicate article/tag pairs', async () => {
    const [first, second] = await Promise.all([
      createArticle(),
      createArticle(),
    ]);
    const [tag, otherTag] = await Promise.all([createTag(), createTag()]);
    await links.insert([
      { articleId: first.id, tagId: tag.id },
      { articleId: first.id, tagId: otherTag.id },
      { articleId: second.id, tagId: tag.id },
    ]);
    expect(await links.countBy({ articleId: first.id })).toBe(2);
    expect(await links.countBy({ tagId: tag.id })).toBe(2);
    await expect(
      links.insert({ articleId: first.id, tagId: tag.id }),
    ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
  });

  it.each(['article', 'tag'] as const)(
    'rejects a link with a nonexistent %s',
    async (missing) => {
      const article = await createArticle();
      const tag = await createTag();
      await expect(
        links.insert({
          articleId: missing === 'article' ? randomUUID() : article.id,
          tagId: missing === 'tag' ? randomUUID() : tag.id,
        }),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_NO_REFERENCED_ROW_2' },
      });
    },
  );

  it('supports multiple favorites per user and per article, with a unique pair', async () => {
    const [first, second] = await Promise.all([
      createArticle(),
      createArticle(),
    ]);
    await favorites.insert([
      { userId: viewer.id, articleId: first.id },
      { userId: viewer.id, articleId: second.id },
      { userId: other.id, articleId: first.id },
    ]);
    expect(await favorites.countBy({ articleId: first.id })).toBe(2);
    expect(await favorites.countBy({ userId: viewer.id })).toBe(2);
    await expect(
      favorites.insert({ userId: viewer.id, articleId: first.id }),
    ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
  });

  it('permits exactly one concurrent insert of the same favorite pair', async () => {
    const article = await createArticle();
    const pair = { userId: viewer.id, articleId: article.id };
    const results = await Promise.allSettled([
      favorites.insert(pair),
      favorites.insert(pair),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(QueryFailedError);
    expect(rejected.reason).toMatchObject({
      driverError: { code: 'ER_DUP_ENTRY' },
    });
    expect(await favorites.countBy(pair)).toBe(1);
  });

  it.each(['user', 'article'] as const)(
    'rejects a favorite with a nonexistent %s',
    async (missing) => {
      const article = await createArticle();
      await expect(
        favorites.insert({
          userId: missing === 'user' ? randomUUID() : viewer.id,
          articleId: missing === 'article' ? randomUUID() : article.id,
        }),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_NO_REFERENCED_ROW_2' },
      });
    },
  );

  it.each([
    ['article_tags', 'article_id'],
    ['article_tags', 'tag_id'],
    ['article_favorites', 'user_id'],
    ['article_favorites', 'article_id'],
  ])('rejects null %s.%s', async (table, column) => {
    const article = await createArticle();
    const tag = await createTag();
    const columns =
      table === 'article_tags'
        ? ['article_id', 'tag_id']
        : ['user_id', 'article_id'];
    const values: (string | null)[] =
      table === 'article_tags' ? [article.id, tag.id] : [viewer.id, article.id];
    values[columns.indexOf(column)] = null;
    // Identifiers come only from the fixed cases above; values remain bound.
    await expect(
      dataSource.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (?, ?)`,
        values,
      ),
    ).rejects.toMatchObject({ driverError: { code: 'ER_BAD_NULL_ERROR' } });
  });

  it('deletes article links and favorites while preserving parents and unrelated rows', async () => {
    const [first, second] = await Promise.all([
      createArticle(),
      createArticle(),
    ]);
    const tag = await createTag();
    await links.insert([
      { articleId: first.id, tagId: tag.id },
      { articleId: second.id, tagId: tag.id },
    ]);
    await favorites.insert([
      { articleId: first.id, userId: viewer.id },
      { articleId: second.id, userId: viewer.id },
    ]);
    await articles.delete(first.id);
    expect(await links.countBy({ articleId: first.id })).toBe(0);
    expect(await favorites.countBy({ articleId: first.id })).toBe(0);
    expect(await links.countBy({ articleId: second.id })).toBe(1);
    expect(await favorites.countBy({ articleId: second.id })).toBe(1);
    expect(await tags.existsBy({ id: tag.id })).toBe(true);
    expect(await users.existsBy({ id: author.id })).toBe(true);
    expect(await users.existsBy({ id: viewer.id })).toBe(true);
  });

  it('deletes tag links without deleting articles or other reusable tags', async () => {
    const article = await createArticle();
    const [tag, retained] = await Promise.all([createTag(), createTag()]);
    await links.insert([
      { articleId: article.id, tagId: tag.id },
      { articleId: article.id, tagId: retained.id },
    ]);
    await tags.delete(tag.id);
    expect(await links.countBy({ tagId: tag.id })).toBe(0);
    expect(await links.countBy({ tagId: retained.id })).toBe(1);
    expect(await articles.existsBy({ id: article.id })).toBe(true);
  });

  it('cascades author deletion and viewer favorites without affecting other articles', async () => {
    const ownArticle = await createArticle();
    const retained = await createArticle({ authorId: other.id });
    const tag = await createTag();
    await links.insert({ articleId: ownArticle.id, tagId: tag.id });
    await favorites.insert([
      { articleId: ownArticle.id, userId: viewer.id },
      { articleId: retained.id, userId: author.id },
      { articleId: retained.id, userId: viewer.id },
    ]);
    await users.delete(author.id);
    expect(await articles.existsBy({ id: ownArticle.id })).toBe(false);
    expect(await links.countBy({ articleId: ownArticle.id })).toBe(0);
    expect(await favorites.countBy({ articleId: ownArticle.id })).toBe(0);
    expect(await favorites.countBy({ userId: author.id })).toBe(0);
    expect(await favorites.countBy({ articleId: retained.id })).toBe(1);
    await users.delete(viewer.id);
    expect(await favorites.countBy({ articleId: retained.id })).toBe(0);
    expect(await articles.existsBy({ id: retained.id })).toBe(true);
    expect(await tags.existsBy({ id: tag.id })).toBe(true);
  });

  it('restricts changes to referenced user, article and tag identifiers', async () => {
    const article = await createArticle();
    const tag = await createTag();
    await links.insert({ articleId: article.id, tagId: tag.id });
    await favorites.insert({ articleId: article.id, userId: viewer.id });
    for (const [repository, id] of [
      [users, author.id],
      [users, viewer.id],
      [articles, article.id],
      [tags, tag.id],
    ] as const) {
      await expect(
        repository.update(id, { id: randomUUID() }),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_ROW_IS_REFERENCED_2' },
      });
    }
  });

  it('reverts, reapplies and repeats the migration while preserving all PR2/PR3 records', async () => {
    for (const table of newTables) {
      const [{ count }] = (await dataSource.query(
        `SELECT COUNT(*) AS count FROM ${table}`,
      )) as { count: string }[];
      if (Number(count) !== 0)
        throw new Error(`Refusing migration roundtrip: nonempty ${table}`);
    }
    const previousTables = ['users', 'follows', 'attachments'];
    await dataSource
      .getRepository(Follow)
      .insert({ followerId: viewer.id, followingId: author.id });
    const attachmentId = randomUUID();
    attachmentIds.push(attachmentId);
    await dataSource.getRepository(Attachment).insert({
      id: attachmentId,
      attachableType: 'user',
      attachableId: author.id,
      url: author.image!,
      fileName: 'existing-avatar.png',
      fileType: 'image/png',
      fileSize: '9007199254740993',
    });
    // Compare hashes so failed assertions cannot print password hashes or data.
    const digest = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const snapshot = async () => {
      const state: Record<string, { rows: string; schema: string }> = {};
      for (const table of previousTables)
        state[table] = {
          rows: digest(
            await dataSource.query(`SELECT * FROM ${table} ORDER BY id`),
          ),
          schema: digest(await dataSource.query(`SHOW CREATE TABLE ${table}`)),
        };
      return state;
    };
    const before = await snapshot();
    const history = (await dataSource.query(
      'SELECT id, timestamp, name FROM migrations ORDER BY id',
    )) as { id: number; timestamp: string; name: string }[];
    expect(history.at(-1)?.name).toBe('CreateArticles1795178319697');
    expect(await dataSource.showMigrations()).toBe(false);
    const runner = dataSource.createQueryRunner();
    try {
      await dataSource.undoLastMigration({ transaction: 'none' });
      for (const table of newTables)
        expect(await runner.hasTable(table)).toBe(false);
      expect(await snapshot()).toEqual(before);
      expect(
        await dataSource.query(
          'SELECT id, timestamp, name FROM migrations ORDER BY id',
        ),
      ).toEqual(history.slice(0, -1));
      const applied = await dataSource.runMigrations({ transaction: 'none' });
      expect(applied.map((migration) => migration.name)).toEqual([
        'CreateArticles1795178319697',
      ]);
      for (const table of newTables)
        expect(await runner.hasTable(table)).toBe(true);
      expect(await snapshot()).toEqual(before);
      expect(await dataSource.runMigrations({ transaction: 'none' })).toEqual(
        [],
      );
      expect(await dataSource.showMigrations()).toBe(false);
      const article = await createArticle();
      const tag = await createTag();
      await links.insert({ articleId: article.id, tagId: tag.id });
      await favorites.insert({ articleId: article.id, userId: viewer.id });
      expect(await favorites.countBy({ articleId: article.id })).toBe(1);
    } finally {
      try {
        // Restore schema/history even when an assertion after revert fails.
        await dataSource.runMigrations({ transaction: 'none' });
      } finally {
        await runner.release();
      }
    }
  }, 30_000);
});
