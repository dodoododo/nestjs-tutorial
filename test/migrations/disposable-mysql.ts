import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { INVALID_USER_PASSWORD_HASH } from '../../src/auth/constants/auth.constant';
import { ArticleFavorite } from '../../src/database/entities/article-favorite.entity';
import { ArticleTag } from '../../src/database/entities/article-tag.entity';
import { Article } from '../../src/database/entities/article.entity';
import { Attachment } from '../../src/database/entities/attachment.entity';
import { Comment } from '../../src/database/entities/comment.entity';
import { Follow } from '../../src/database/entities/follow.entity';
import { Tag } from '../../src/database/entities/tag.entity';
import { User } from '../../src/database/entities/user.entity';
import { CreateUsers1794641130970 } from '../../src/database/migrations/1794641130970-CreateUsers';
import { CreateFollows1795172102120 } from '../../src/database/migrations/1795172102120-CreateFollows';
import { CreateAttachments1795173453495 } from '../../src/database/migrations/1795173453495-CreateAttachments';
import { CreateArticles1795178319697 } from '../../src/database/migrations/1795178319697-CreateArticles';
import { AddUserTokenVersion1795402800000 } from '../../src/database/migrations/1795402800000-AddUserTokenVersion';
import { disposableMigrationTarget } from './disposable-migration-target';

// Fixed fixture boundary; future application migrations are never discovered.
export const prerequisiteMigrations = [
  CreateUsers1794641130970,
  CreateFollows1795172102120,
  CreateAttachments1795173453495,
  CreateArticles1795178319697,
  AddUserTokenVersion1795402800000,
];

export async function openDisposableMysql(
  domain: 'comment' | 'attachment',
  migrations: DataSourceOptions['migrations'],
  migrationsTableName: string,
): Promise<DataSource> {
  const { serverUuid, serverHostname, ...connection } =
    disposableMigrationTarget(domain, process.env);
  const source = new DataSource({
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
      Comment,
    ],
    migrations,
    migrationsTableName,
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
  });
  await source.initialize();
  try {
    const [identity] = (await source.query(
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
      db: connection.database,
      account: `${connection.username}@%`,
    });
    return source;
  } catch (error) {
    await source.destroy();
    throw error;
  }
}

export async function schemaTables(source: DataSource): Promise<string[]> {
  const rows = (await source.query(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME',
  )) as { name: string }[];
  return rows.map((row) => row.name);
}

export async function migrationHistory(
  source: DataSource,
  table = 'migrations',
) {
  // Identifiers are a closed whitelist; only dedicated test ledgers are queried.
  if (
    !['migrations', 'comment_migrations', 'attachment_migrations'].includes(
      table,
    )
  )
    throw new Error('Unknown migration fixture history table');
  return source.query<{ id: number; timestamp: string; name: string }[]>(
    `SELECT id, timestamp, name FROM ${table} ORDER BY id`,
  );
}

export async function snapshotEarlierTables(
  source: DataSource,
  includeAttachments: boolean,
) {
  const tables = [
    ['users', 'id'],
    ['follows', 'id'],
    ...(includeAttachments ? [['attachments', 'id']] : []),
    ['articles', 'id'],
    ['tags', 'id'],
    ['article_tags', 'article_id, tag_id'],
    ['article_favorites', 'user_id, article_id'],
  ];
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const state: Record<string, { rows: string; schema: string }> = {};
  for (const [table, order] of tables) {
    state[table!] = {
      rows: digest(
        await source.query(`SELECT * FROM ${table} ORDER BY ${order}`),
      ),
      schema: digest(await source.query(`SHOW CREATE TABLE ${table}`)),
    };
  }
  return state;
}

export async function fixtureUser(source: DataSource) {
  const id = randomUUID();
  return source.getRepository(User).save({
    id,
    username: `comment_${id}`,
    email: `comment_${id}@example.test`,
    passwordHash: INVALID_USER_PASSWORD_HASH,
    tokenVersion: 7,
    bio: 'Existing profile',
    image: '/existing-avatar.png',
  });
}

export async function fixtureArticle(source: DataSource, authorId: string) {
  const id = randomUUID();
  return source.getRepository(Article).save({
    id,
    slug: `migration-${id}`,
    title: 'Existing article',
    description: 'Existing description',
    body: 'Existing article body',
    authorId,
  });
}
