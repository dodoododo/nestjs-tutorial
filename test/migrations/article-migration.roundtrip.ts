import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';

import { INVALID_USER_PASSWORD_HASH } from '../../src/auth/constants/auth.constant';
import { ArticleFavorite } from '../../src/database/entities/article-favorite.entity';
import { ArticleTag } from '../../src/database/entities/article-tag.entity';
import { Article } from '../../src/database/entities/article.entity';
import { Attachment } from '../../src/database/entities/attachment.entity';
import { Follow } from '../../src/database/entities/follow.entity';
import { Tag } from '../../src/database/entities/tag.entity';
import { User } from '../../src/database/entities/user.entity';
import { CreateUsers1794641130970 } from '../../src/database/migrations/1794641130970-CreateUsers';
import { CreateFollows1795172102120 } from '../../src/database/migrations/1795172102120-CreateFollows';
import { CreateAttachments1795173453495 } from '../../src/database/migrations/1795173453495-CreateAttachments';
import { CreateArticles1795178319697 } from '../../src/database/migrations/1795178319697-CreateArticles';
import { AddUserTokenVersion1795402800000 } from '../../src/database/migrations/1795402800000-AddUserTokenVersion';
import { articleMigrationTarget } from './article-migration-target';

describe('Article migration (disposable MySQL only)', () => {
  let dataSource: DataSource;
  let author: User;
  let viewer: User;
  let articles: Repository<Article>;
  let tags: Repository<Tag>;
  let links: Repository<ArticleTag>;
  let favorites: Repository<ArticleFavorite>;
  const newTables = ['articles', 'tags', 'article_tags', 'article_favorites'];

  async function createArticle() {
    const id = randomUUID();
    return articles.save({
      id,
      slug: `article-${id}`,
      title: 'Article title',
      description: 'Article description',
      body: 'Article body',
      authorId: author.id,
    });
  }

  async function createTag() {
    const id = randomUUID();
    return tags.save({ id, name: `tag_${id}` });
  }

  beforeAll(async () => {
    const { serverUuid, serverHostname, ...connection } =
      articleMigrationTarget(process.env);
    dataSource = new DataSource({
      ...connection,
      type: 'mysql',
      supportBigNumbers: true,
      bigNumberStrings: true,
      entities: [
        User,
        Follow,
        Attachment,
        Article,
        ArticleTag,
        ArticleFavorite,
        Tag,
      ],
      // Explicit PR4 boundary: future downstream migrations must not be applied
      // to a schema whose Article tables this test intentionally drops.
      migrations: [
        CreateUsers1794641130970,
        CreateFollows1795172102120,
        CreateAttachments1795173453495,
        CreateArticles1795178319697,
        AddUserTokenVersion1795402800000,
      ],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    // Identity and emptiness are checked before migrations or fixture writes.
    const [identity] = (await dataSource.query(
      'SELECT @@server_uuid AS serverUuid, @@hostname AS hostname, DATABASE() AS db, CURRENT_USER() AS account',
    )) as {
      serverUuid: string;
      hostname: string;
      db: string;
      account: string;
    }[];
    expect(identity).toEqual({
      serverUuid,
      hostname: serverHostname,
      db: 'nestjs_article_migration_test',
      account: 'article_migration_test@%',
    });
    expect(
      await dataSource.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
      ),
    ).toEqual([]);
    const applied = await dataSource.runMigrations({ transaction: 'none' });
    expect(applied.map((migration) => migration.name)).toEqual([
      'CreateUsers1794641130970',
      'CreateFollows1795172102120',
      'CreateAttachments1795173453495',
      'CreateArticles1795178319697',
      'AddUserTokenVersion1795402800000',
    ]);
    console.info(
      'Applied all five PR4 migrations to the empty disposable schema',
    );
    const users = dataSource.getRepository(User);
    [author, viewer] = await users.save(
      Array.from({ length: 3 }, () => {
        const id = randomUUID();
        return users.create({
          id,
          username: `article_${id}`,
          email: `article_${id}@example.test`,
          passwordHash: INVALID_USER_PASSWORD_HASH,
          tokenVersion: 7,
          bio: 'Existing profile',
          image: '/existing-avatar.png',
        });
      }),
    );
    articles = dataSource.getRepository(Article);
    tags = dataSource.getRepository(Tag);
    links = dataSource.getRepository(ArticleTag);
    favorites = dataSource.getRepository(ArticleFavorite);
  }, 30_000);

  afterAll(async () => {
    // The runner removes this entire disposable container, including fixtures.
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('roundtrips only the Article migration while preserving later PR3 migrations and records', async () => {
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
    expect(history.map((migration) => migration.name)).toContain(
      'CreateArticles1795178319697',
    );
    expect(history.map((migration) => migration.name)).toContain(
      'AddUserTokenVersion1795402800000',
    );
    expect(await dataSource.showMigrations()).toBe(false);
    const runner = dataSource.createQueryRunner();
    const migration = new CreateArticles1795178319697();
    let needsRestore = false;
    try {
      // Refuse shared schemas containing downstream foreign keys before any DDL.
      const externalReferences = (await runner.query(
        `SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE REFERENCED_TABLE_SCHEMA = DATABASE()
           AND REFERENCED_TABLE_NAME IN ('articles', 'tags', 'article_tags', 'article_favorites')
           AND TABLE_NAME NOT IN ('articles', 'tags', 'article_tags', 'article_favorites')`,
      )) as { TABLE_NAME: string }[];
      if (externalReferences.length)
        throw new Error(
          'Migration roundtrip requires an isolated PR4 schema without downstream foreign keys',
        );
      // Do not undo the last migration: PR3 token_version is newer than Articles.
      // Exercise this migration directly, leaving every migration record intact.
      needsRestore = true;
      await migration.down(runner);
      for (const table of newTables)
        expect(await runner.hasTable(table)).toBe(false);
      expect(await snapshot()).toEqual(before);
      expect(
        await dataSource.query(
          'SELECT id, timestamp, name FROM migrations ORDER BY id',
        ),
      ).toEqual(history);
      await migration.up(runner);
      needsRestore = false;
      for (const table of newTables)
        expect(await runner.hasTable(table)).toBe(true);
      expect(await snapshot()).toEqual(before);
      expect(
        await dataSource.query(
          'SELECT id, timestamp, name FROM migrations ORDER BY id',
        ),
      ).toEqual(history);
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
        if (needsRestore) {
          // Recover even a partially completed DDL roundtrip of the empty tables.
          for (const table of [...newTables].reverse()) {
            if (await runner.hasTable(table)) await runner.dropTable(table);
          }
          await migration.up(runner);
        }
      } finally {
        await runner.release();
      }
    }
  }, 30_000);
});
