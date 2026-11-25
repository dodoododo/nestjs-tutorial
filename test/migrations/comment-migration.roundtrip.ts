import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ArticleFavorite } from '../../src/database/entities/article-favorite.entity';
import { ArticleTag } from '../../src/database/entities/article-tag.entity';
import { Article } from '../../src/database/entities/article.entity';
import { Attachment } from '../../src/database/entities/attachment.entity';
import { Comment } from '../../src/database/entities/comment.entity';
import { Follow } from '../../src/database/entities/follow.entity';
import { Tag } from '../../src/database/entities/tag.entity';
import { User } from '../../src/database/entities/user.entity';
import { CreateComments1795251668000 } from '../../src/database/migrations/1795251668000-CreateComments';
import { expectCommentSchema } from '../helpers/expect-comment-schema';
import {
  fixtureArticle,
  fixtureUser,
  migrationHistory,
  openDisposableMysql,
  prerequisiteMigrations,
  schemaTables,
  snapshotEarlierTables,
} from './disposable-mysql';

describe('Comments migration (disposable MySQL only)', () => {
  const migrationName = 'CreateComments1795251668000';
  let prerequisites: DataSource;
  let source: DataSource;

  beforeAll(async () => {
    prerequisites = await openDisposableMysql(
      'comment',
      prerequisiteMigrations,
      'migrations',
    );
    // Verify the runner's new schema is empty before any migration or fixture DDL.
    expect(await schemaTables(prerequisites)).toEqual([]);
    const applied = await prerequisites.runMigrations({ transaction: 'none' });
    expect(applied.map((migration) => migration.name)).toEqual([
      'CreateUsers1794641130970',
      'CreateFollows1795172102120',
      'CreateAttachments1795173453495',
      'CreateArticles1795178319697',
      'AddUserTokenVersion1795402800000',
    ]);
    expect(await prerequisites.showMigrations()).toBe(false);
    // A separate, test-only ledger lets TypeORM itself exercise selected DOWN/UP
    // history semantics while the newer token-version migration stays applied.
    source = await openDisposableMysql(
      'comment',
      [CreateComments1795251668000],
      'comment_migrations',
    );
    expect(
      (await source.runMigrations({ transaction: 'none' })).map(
        (migration) => migration.name,
      ),
    ).toEqual([migrationName]);
    expect(await source.showMigrations()).toBe(false);
  }, 30_000);

  afterAll(async () => {
    try {
      if (source?.isInitialized) await source.destroy();
    } finally {
      if (prerequisites?.isInitialized) await prerequisites.destroy();
    }
  });

  it('roundtrips only Comments with real history changes and preserves PR2/PR3/PR4 data and schema', async () => {
    const comments = source.getRepository(Comment);
    await expectCommentSchema(source);
    if (await comments.count())
      throw new Error('Refusing roundtrip: comments is nonempty');
    const owner = await fixtureUser(source);
    const viewer = await fixtureUser(source);
    const other = await fixtureUser(source);
    const article = await fixtureArticle(source, owner.id);
    const unrelated = await fixtureArticle(source, other.id);
    const tag = await source
      .getRepository(Tag)
      .save({ name: `comment_${randomUUID()}` });
    await source
      .getRepository(ArticleTag)
      .insert({ articleId: article.id, tagId: tag.id });
    await source
      .getRepository(ArticleFavorite)
      .insert({ articleId: article.id, userId: viewer.id });
    await source
      .getRepository(Follow)
      .insert({ followerId: viewer.id, followingId: owner.id });
    await source.getRepository(Attachment).insert({
      id: randomUUID(),
      attachableType: 'user',
      attachableId: owner.id,
      url: '/existing-avatar.png',
      fileName: 'existing-avatar.png',
      fileType: 'image/png',
      fileSize: '9007199254740993',
    });
    const snapshot = () => snapshotEarlierTables(source, true);
    const before = await snapshot();
    const beforeHistory = await migrationHistory(source);
    expect(beforeHistory.map((row) => row.name)).toEqual([
      'CreateUsers1794641130970',
      'CreateFollows1795172102120',
      'CreateAttachments1795173453495',
      'CreateArticles1795178319697',
      'AddUserTokenVersion1795402800000',
    ]);
    const selectedHistory = await migrationHistory(
      source,
      'comment_migrations',
    );
    expect(selectedHistory).toHaveLength(1);
    expect(selectedHistory[0]).toMatchObject({
      name: migrationName,
      timestamp: '1795251668000',
    });
    const tablesBefore = await schemaTables(source);
    const runner = source.createQueryRunner();
    try {
      const references = (await runner.query(
        `SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'comments'`,
      )) as { TABLE_NAME: string }[];
      if (references.length)
        throw new Error('Refusing roundtrip: downstream Comments foreign keys');
      await source.undoLastMigration({ transaction: 'none' });
      expect(await runner.hasTable('comments')).toBe(false);
      expect(await schemaTables(source)).toEqual(
        tablesBefore.filter((table) => table !== 'comments'),
      );
      expect(await migrationHistory(source, 'comment_migrations')).toEqual([]);
      expect(await migrationHistory(source)).toEqual(beforeHistory);
      expect(await snapshot()).toEqual(before);
      expect(
        (await source.runMigrations({ transaction: 'none' })).map(
          (migration) => migration.name,
        ),
      ).toEqual([migrationName]);
      expect(await runner.hasTable('comments')).toBe(true);
      expect(await schemaTables(source)).toEqual(tablesBefore);
      await expectCommentSchema(source);
      const afterHistory = await migrationHistory(source, 'comment_migrations');
      expect(afterHistory).toHaveLength(1);
      expect(afterHistory[0]).toMatchObject({
        name: selectedHistory[0]!.name,
        timestamp: selectedHistory[0]!.timestamp,
      });
      expect(afterHistory[0]!.id).toBeGreaterThan(selectedHistory[0]!.id);
      expect(await migrationHistory(source)).toEqual(beforeHistory);
      expect(await snapshot()).toEqual(before);
      expect(await source.runMigrations({ transaction: 'none' })).toEqual([]);
      expect(
        await prerequisites.runMigrations({ transaction: 'none' }),
      ).toEqual([]);
      expect(await migrationHistory(source, 'comment_migrations')).toEqual(
        afterHistory,
      );
      expect(await source.showMigrations()).toBe(false);
      expect(await prerequisites.showMigrations()).toBe(false);

      const retained = await comments.save({
        articleId: article.id,
        authorId: viewer.id,
        body: '  Comment\n\nformatting  ',
      });
      expect(await comments.findOneByOrFail({ id: retained.id })).toMatchObject(
        {
          body: retained.body,
          authorId: viewer.id,
          articleId: article.id,
        },
      );
      for (const invalid of [
        { articleId: randomUUID(), authorId: viewer.id },
        { articleId: article.id, authorId: randomUUID() },
      ])
        await expect(
          comments.insert({ ...invalid, body: 'Invalid parent' }),
        ).rejects.toMatchObject({
          driverError: { code: 'ER_NO_REFERENCED_ROW_2' },
        });
      await expect(
        source.getRepository(User).update(viewer.id, { id: randomUUID() }),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_ROW_IS_REFERENCED_2' },
      });
      await expect(
        source.getRepository(Article).update(article.id, { id: randomUUID() }),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_ROW_IS_REFERENCED_2' },
      });
      const disposableArticle = await fixtureArticle(source, owner.id);
      const articleChild = await comments.save({
        articleId: disposableArticle.id,
        authorId: viewer.id,
        body: 'Article cascade',
      });
      await source.getRepository(Article).delete(disposableArticle.id);
      expect(await comments.existsBy({ id: articleChild.id })).toBe(false);
      const disposableAuthor = await fixtureUser(source);
      const authorChild = await comments.save({
        articleId: unrelated.id,
        authorId: disposableAuthor.id,
        body: 'Author cascade',
      });
      await source.getRepository(User).delete(disposableAuthor.id);
      expect(await comments.existsBy({ id: authorChild.id })).toBe(false);
      expect(await comments.findOneByOrFail({ id: retained.id })).toMatchObject(
        { body: retained.body },
      );
      expect(
        await source
          .getRepository(Article)
          .findOneByOrFail({ id: unrelated.id }),
      ).toEqual(unrelated);
      await comments.delete(retained.id);
      expect(await snapshot()).toEqual(before);
      expect(await migrationHistory(source)).toEqual(beforeHistory);
    } finally {
      // DDL cannot be rolled back transactionally. Never attempt partial repairs
      // here: the runner removes the entire owned container on failure too.
      await runner.release();
    }
  }, 30_000);
});
