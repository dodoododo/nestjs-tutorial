import { JwtService } from '@nestjs/jwt';
import type { DataSourceOptions } from 'typeorm';
import request from 'supertest';
import { Article } from '../../src/database/entities/article.entity';
import { ArticleFavorite } from '../../src/database/entities/article-favorite.entity';
import { ArticleTag } from '../../src/database/entities/article-tag.entity';
import { Attachment } from '../../src/database/entities/attachment.entity';
import { Comment } from '../../src/database/entities/comment.entity';
import { Follow } from '../../src/database/entities/follow.entity';
import { Tag } from '../../src/database/entities/tag.entity';
import { User } from '../../src/database/entities/user.entity';
import {
  assertC2DatabaseOptions,
  C2DatabaseLifecycle,
} from './helpers/c2-database';
import { C2_DATABASE, C2SafetyError } from './helpers/c2-environment';
import { createProfileFixtures } from './helpers/profile-fixtures';

import { setupC2Suite } from './helpers/setup-c2-suite';

describe('Profiles C2 database lifecycle (infrastructure only)', () => {
  const suite = setupC2Suite();
  const profile = (following: boolean) => ({
    profile: {
      username: suite.fixtures.target.username,
      bio: suite.fixtures.target.bio,
      image: suite.fixtures.target.image,
      following,
    },
  });
  const profilePath = () =>
    `/api/profiles/${encodeURIComponent(suite.fixtures.target.username)}`;

  it('creates three persisted fixtures and reads the exact public profile over HTTP', async () => {
    const stored = await suite.dataSource
      .getRepository(User)
      .findOneByOrFail({ id: suite.fixtures.target.id });
    const response = await request(suite.app.getHttpServer())
      .get(profilePath())
      .expect(200);
    expect(response.body).toEqual(profile(false));
    expect(response.body.profile).toEqual({
      username: stored.username,
      bio: stored.bio,
      image: stored.image,
      following: false,
    });
    for (const user of [suite.fixtures.actor, suite.fixtures.other])
      expect(
        await suite.dataSource.getRepository(User).existsBy({ id: user.id }),
      ).toBe(true);
    expect(await suite.dataSource.getRepository(Follow).count()).toBe(0);
  });

  it('executes JWT guard, controller and service to persist a Follow visible in the next HTTP read', async () => {
    const response = await request(suite.app.getHttpServer())
      .post(`${profilePath()}/follow`)
      .set('Authorization', `Bearer ${suite.fixtures.token}`)
      .expect(200);
    expect(response.body).toEqual(profile(true));
    expect(await suite.dataSource.getRepository(Follow).find()).toEqual([
      expect.objectContaining({
        followerId: suite.fixtures.actor.id,
        followingId: suite.fixtures.target.id,
      }),
    ]);
    const read = await request(suite.app.getHttpServer())
      .get(profilePath())
      .set('Authorization', `Bearer ${suite.fixtures.token}`)
      .expect(200);
    expect(read.body).toEqual(response.body);
    expect(await suite.dataSource.getRepository(User).count()).toBe(3);
  });

  it('supports explicit fixtures with an existing persisted Follow and unique valid JWTs', async () => {
    await suite.database.truncate();
    const previousToken = suite.fixtures.token;
    suite.fixtures = await createProfileFixtures(
      suite.dataSource,
      suite.app.get(JwtService),
      suite.revocationKeys,
      { following: true },
    );
    expect(suite.fixtures.token).not.toBe(previousToken);
    const read = await request(suite.app.getHttpServer())
      .get(profilePath())
      .set('Authorization', `Bearer ${suite.fixtures.token}`)
      .expect(200);
    expect(read.body).toEqual(profile(true));
    expect(
      await suite.dataSource.getRepository(Follow).countBy({
        followerId: suite.fixtures.actor.id,
        followingId: suite.fixtures.target.id,
      }),
    ).toBe(1);
  });

  it('tracks real logout revocation keys for afterEach cleanup', async () => {
    await request(suite.app.getHttpServer())
      .post('/api/logout')
      .set('Authorization', `Bearer ${suite.fixtures.token}`)
      .expect(204);
    expect(suite.revocationKeys.size).toBe(1);
    expect(await suite.redis.get([...suite.revocationKeys][0])).toBe('1');
    expect(await suite.dataSource.getRepository(User).count()).toBe(3);
  });

  it('truncates the complete application graph and preserves migration history', async () => {
    const article = await suite.dataSource.getRepository(Article).save({
      slug: `c2-${suite.fixtures.actor.id}`,
      title: 'Fixture article',
      description: 'Lifecycle fixture',
      body: 'Fixture body',
      authorId: suite.fixtures.actor.id,
    });
    const tag = await suite.dataSource
      .getRepository(Tag)
      .save({ name: 'c2-fixture' });
    await suite.dataSource.getRepository(ArticleTag).insert({
      articleId: article.id,
      tagId: tag.id,
    });
    await suite.dataSource.getRepository(ArticleFavorite).insert({
      articleId: article.id,
      userId: suite.fixtures.target.id,
    });
    await suite.dataSource.getRepository(Comment).save({
      articleId: article.id,
      authorId: suite.fixtures.other.id,
      body: 'Fixture comment',
    });
    await suite.dataSource.getRepository(Attachment).save({
      attachableType: 'user',
      attachableId: suite.fixtures.actor.id,
      url: '/fixtures/actor.png',
      fileName: 'actor.png',
      fileType: 'image/png',
      fileSize: '100',
    });
    await suite.dataSource.getRepository(Follow).save({
      followerId: suite.fixtures.actor.id,
      followingId: suite.fixtures.target.id,
    });
    expect(await suite.database.counts()).toEqual({
      ...suite.emptyCounts,
      users: 3,
      follows: 1,
      articles: 1,
      tags: 1,
      article_tags: 1,
      article_favorites: 1,
      comments: 1,
      attachments: 1,
    });
    await suite.database.truncate();
    expect(await suite.database.counts()).toEqual(suite.emptyCounts);
    expect(await suite.history()).toEqual(suite.migrationHistory);
    expect(await suite.database.assertSession()).toBe(1);
  });

  it('discovers a future application table, excludes views and preserves migrations', async () => {
    const runner = suite.database.runner;
    await suite.database.assertSession();
    try {
      await runner.query(
        `CREATE TABLE \`${C2_DATABASE}\`.\`c2_future_data\` (id INT PRIMARY KEY)`,
      );
      await runner.query(
        `INSERT INTO \`${C2_DATABASE}\`.\`c2_future_data\` VALUES (1)`,
      );
      await runner.query(
        `CREATE VIEW \`${C2_DATABASE}\`.\`c2_future_view\` AS SELECT id FROM users`,
      );
      const counts = await suite.database.counts();
      expect(counts.c2_future_data).toBe(1);
      expect(counts).not.toHaveProperty('c2_future_view');
      expect(counts).not.toHaveProperty('migrations');
      await suite.database.truncate();
      expect(await suite.database.counts()).toEqual({
        ...suite.emptyCounts,
        c2_future_data: 0,
      });
      expect(await suite.history()).toEqual(suite.migrationHistory);
    } finally {
      await suite.database.assertSession();
      await runner.query(
        `DROP VIEW IF EXISTS \`${C2_DATABASE}\`.\`c2_future_view\``,
      );
      await runner.query(
        `DROP TABLE IF EXISTS \`${C2_DATABASE}\`.\`c2_future_data\``,
      );
    }
  });

  it('rejects unsafe configured targets before a destructive query', () => {
    const unsafeOptions = [
      { database: 'nestjs_tutorial_test' },
      { database: 'nestjs_tutorial' },
      { type: 'postgres' },
      { host: 'localhost' },
      { port: 3307 },
      { username: 'nestjs_test' },
      { synchronize: true },
      { migrationsRun: true },
      { migrationsTableName: 'other_ledger' },
      { dropSchema: true },
      { url: 'mysql://unapproved.invalid' },
      { socketPath: '/unapproved.sock' },
      { extra: { host: 'unapproved.invalid' } },
    ];
    for (const unsafe of unsafeOptions)
      expect(() =>
        assertC2DatabaseOptions({
          ...suite.dataSource.options,
          ...unsafe,
        } as DataSourceOptions),
      ).toThrow(C2SafetyError);
    expect(() =>
      assertC2DatabaseOptions(suite.dataSource.options, 'development'),
    ).toThrow(C2SafetyError);
  });

  it('rejects a live connection selecting a different schema without touching fixtures', async () => {
    await suite.database.runner.query('USE information_schema');
    try {
      await expect(suite.database.truncate()).rejects.toThrow(C2SafetyError);
      expect(await suite.dataSource.getRepository(User).count()).toBe(3);
    } finally {
      await suite.database.runner.query(`USE \`${C2_DATABASE}\``);
    }
  });

  it('cannot select the existing shared E2E schema with the dedicated account', async () => {
    await expect(
      suite.database.runner.query('USE `nestjs_tutorial_test`'),
    ).rejects.toMatchObject({
      driverError: { code: 'ER_DBACCESS_DENIED_ERROR' },
    });
    expect(await suite.database.assertSession()).toBe(1);
    expect(await suite.dataSource.getRepository(User).count()).toBe(3);
  });

  it('rejects a second concurrent lifecycle before it can clean this suite fixtures', async () => {
    const second = new C2DatabaseLifecycle(suite.dataSource);
    try {
      await expect(second.start(suite.redis)).rejects.toThrow(
        'Another C2 lifecycle owns this schema',
      );
      expect(await suite.dataSource.getRepository(User).count()).toBe(3);
    } finally {
      await second.close();
    }
  });

  it('restores real session FK checks after a simulated TRUNCATE infrastructure failure', async () => {
    const execute = suite.database.runner.query.bind(suite.database.runner);
    let hasInjectedFailure = false;
    // Only this negative infrastructure test simulates a DB failure. All reads,
    // FK changes and normal lifecycle DDL still execute against real MySQL.
    const query = jest
      .spyOn(suite.database.runner, 'query')
      .mockImplementation((sql: string, parameters?: unknown[]) => {
        if (!hasInjectedFailure && sql.startsWith('TRUNCATE TABLE')) {
          hasInjectedFailure = true;
          return Promise.reject(
            new C2SafetyError('Simulated TRUNCATE failure'),
          );
        }
        return execute(sql, parameters);
      });
    try {
      await expect(suite.database.truncate()).rejects.toThrow(
        'C2 TRUNCATE cleanup failed',
      );
      expect(hasInjectedFailure).toBe(true);
      expect(await suite.database.assertSession()).toBe(1);
      expect(await suite.dataSource.getRepository(User).count()).toBe(3);
    } finally {
      query.mockRestore();
    }
  });
});
