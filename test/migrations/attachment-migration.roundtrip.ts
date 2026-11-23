import { DataSource } from 'typeorm';
import { Attachment } from '../../src/database/entities/attachment.entity';
import { Follow } from '../../src/database/entities/follow.entity';
import { CreateAttachments1795173453495 } from '../../src/database/migrations/1795173453495-CreateAttachments';
import { expectAttachmentSchema } from '../helpers/expect-attachment-schema';
import {
  fixtureArticle,
  fixtureUser,
  migrationHistory,
  openDisposableMysql,
  prerequisiteMigrations,
  schemaTables,
  snapshotEarlierTables,
} from './disposable-mysql';

describe('Attachments migration (disposable MySQL only)', () => {
  const migrationName = 'CreateAttachments1795173453495';
  let prerequisites: DataSource;
  let source: DataSource;

  beforeAll(async () => {
    prerequisites = await openDisposableMysql(
      'attachment',
      prerequisiteMigrations.filter(
        (migration) => migration !== CreateAttachments1795173453495,
      ),
      'migrations',
    );
    expect(await schemaTables(prerequisites)).toEqual([]);
    expect(
      (await prerequisites.runMigrations({ transaction: 'none' })).map(
        (migration) => migration.name,
      ),
    ).toEqual([
      'CreateUsers1794641130970',
      'CreateFollows1795172102120',
      'CreateArticles1795178319697',
      'AddUserTokenVersion1795402800000',
    ]);
    expect(await prerequisites.showMigrations()).toBe(false);
    source = await openDisposableMysql(
      'attachment',
      [CreateAttachments1795173453495],
      'attachment_migrations',
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

  it('roundtrips Attachments while preserving Users, Follows, Articles and later PR3 history', async () => {
    await expectAttachmentSchema(source);
    const attachments = source.getRepository(Attachment);
    if (await attachments.count())
      throw new Error('Refusing roundtrip: attachments is nonempty');
    const owner = await fixtureUser(source);
    const follower = await fixtureUser(source);
    await source
      .getRepository(Follow)
      .insert({ followerId: follower.id, followingId: owner.id });
    await fixtureArticle(source, owner.id);
    const snapshot = () => snapshotEarlierTables(source, false);
    const before = await snapshot();
    const beforeHistory = await migrationHistory(source);
    expect(beforeHistory.map((row) => row.name)).toEqual([
      'CreateUsers1794641130970',
      'CreateFollows1795172102120',
      'CreateArticles1795178319697',
      'AddUserTokenVersion1795402800000',
    ]);
    const selectedHistory = await migrationHistory(
      source,
      'attachment_migrations',
    );
    expect(selectedHistory).toHaveLength(1);
    expect(selectedHistory[0]).toMatchObject({
      name: migrationName,
      timestamp: '1795173453495',
    });
    const tablesBefore = await schemaTables(source);
    const runner = source.createQueryRunner();
    try {
      const references = (await runner.query(
        `SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'attachments'`,
      )) as { TABLE_NAME: string }[];
      if (references.length)
        throw new Error(
          'Refusing roundtrip: downstream Attachment foreign keys',
        );
      await source.undoLastMigration({ transaction: 'none' });
      expect(await runner.hasTable('attachments')).toBe(false);
      expect(await schemaTables(source)).toEqual(
        tablesBefore.filter((table) => table !== 'attachments'),
      );
      expect(await migrationHistory(source, 'attachment_migrations')).toEqual(
        [],
      );
      expect(await migrationHistory(source)).toEqual(beforeHistory);
      expect(await snapshot()).toEqual(before);
      expect(
        (await source.runMigrations({ transaction: 'none' })).map(
          (migration) => migration.name,
        ),
      ).toEqual([migrationName]);
      expect(await runner.hasTable('attachments')).toBe(true);
      expect(await schemaTables(source)).toEqual(tablesBefore);
      await expectAttachmentSchema(source);
      expect(await snapshot()).toEqual(before);
      expect(await migrationHistory(source)).toEqual(beforeHistory);
      const afterHistory = await migrationHistory(
        source,
        'attachment_migrations',
      );
      expect(afterHistory).toHaveLength(1);
      expect(afterHistory[0]).toMatchObject({
        name: selectedHistory[0]!.name,
        timestamp: selectedHistory[0]!.timestamp,
      });
      expect(afterHistory[0]!.id).toBeGreaterThan(selectedHistory[0]!.id);
      expect(await source.runMigrations({ transaction: 'none' })).toEqual([]);
      expect(
        await prerequisites.runMigrations({ transaction: 'none' }),
      ).toEqual([]);
      expect(await migrationHistory(source, 'attachment_migrations')).toEqual(
        afterHistory,
      );
      expect(await source.showMigrations()).toBe(false);
      expect(await prerequisites.showMigrations()).toBe(false);
      const saved = await attachments.save({
        attachableType: 'user',
        attachableId: owner.id,
        url: '/existing-avatar.png',
        fileName: 'existing-avatar.png',
        fileType: 'image/png',
        fileSize: '9007199254740993',
      });
      expect(await attachments.findOneByOrFail({ id: saved.id })).toMatchObject(
        {
          attachableId: owner.id,
          fileSize: '9007199254740993',
        },
      );
      expect(await snapshot()).toEqual(before);
      expect(await migrationHistory(source)).toEqual(beforeHistory);
    } finally {
      // The owned disposable server is removed even after partially failed DDL.
      await runner.release();
    }
  }, 30_000);
});
