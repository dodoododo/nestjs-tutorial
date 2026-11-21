import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { DataSource, type DataSourceOptions } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { setupCommentBodyParser } from '../../src/comments/comment-body-parser';
import { Article } from '../../src/database/entities/article.entity';
import { ArticleFavorite } from '../../src/database/entities/article-favorite.entity';
import { ArticleTag } from '../../src/database/entities/article-tag.entity';
import { Attachment } from '../../src/database/entities/attachment.entity';
import { Comment } from '../../src/database/entities/comment.entity';
import { Follow } from '../../src/database/entities/follow.entity';
import { Tag } from '../../src/database/entities/tag.entity';
import { User } from '../../src/database/entities/user.entity';
import { REDIS_CLIENT } from '../../src/redis/redis.constant';
import {
  assertC2DatabaseOptions,
  C2DatabaseLifecycle,
  C2_TABLES,
} from './helpers/c2-database';
import { C2_DATABASE, C2SafetyError } from './helpers/c2-environment';
import {
  cleanC2RedisKeys,
  createProfileFixtures,
} from './helpers/profile-fixtures';

describe('Profiles C2 database lifecycle (infrastructure only)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let database: C2DatabaseLifecycle;
  let fixtures: Awaited<ReturnType<typeof createProfileFixtures>>;
  let migrationHistory: unknown;
  let isLifecycleReady = false;
  const revocationKeys = new Set<string>();
  const previousIds = new Set<string>();
  const previousKeys = new Set<string>();
  const emptyCounts = Object.fromEntries(C2_TABLES.map((table) => [table, 0]));

  const history = (): Promise<unknown> =>
    dataSource.query('SELECT id, timestamp, name FROM migrations ORDER BY id');
  const profile = (following: boolean) => ({
    profile: {
      username: fixtures.target.username,
      bio: fixtures.target.bio,
      image: fixtures.target.image,
      following,
    },
  });
  const profilePath = () =>
    `/api/profiles/${encodeURIComponent(fixtures.target.username)}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');
    setupCommentBodyParser(app);
    await app.init();
    dataSource = app.get(DataSource);
    redis = app.get<Redis>(REDIS_CLIENT);
    database = new C2DatabaseLifecycle(dataSource);
    await database.start(redis);
    migrationHistory = await history();
    expect(await database.counts()).toEqual(emptyCounts);
    isLifecycleReady = true;
  });

  beforeEach(async () => {
    // These invariants run for every case, including when a case runs alone.
    expect(await database.counts()).toEqual(emptyCounts);
    for (const id of previousIds)
      expect(await dataSource.getRepository(User).existsBy({ id })).toBe(false);
    for (const key of previousKeys) expect(await redis.exists(key)).toBe(0);
    fixtures = await createProfileFixtures(
      dataSource,
      app.get(JwtService),
      revocationKeys,
    );
    expect(await dataSource.getRepository(User).count()).toBe(3);
    expect(await dataSource.getRepository(Follow).count()).toBe(0);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // A refused/failed beforeAll never creates per-case fixtures. Do not attempt
    // destructive teardown after an incomplete isolation/migration preflight.
    if (!isLifecycleReady) return;
    previousIds.clear();
    previousKeys.clear();
    if (fixtures)
      for (const user of [fixtures.actor, fixtures.target, fixtures.other])
        previousIds.add(user.id);
    for (const key of revocationKeys) previousKeys.add(key);
    // Attempt both cleanups and report every failure, rather than masking one.
    const outcomes = await Promise.allSettled([
      database.truncate(),
      cleanC2RedisKeys(redis, revocationKeys),
    ]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, 'C2 teardown failed');
    expect(await database.counts()).toEqual(emptyCounts);
    expect(await database.assertSession()).toBe(1);
    expect(await history()).toEqual(migrationHistory);
    for (const key of previousKeys) expect(await redis.exists(key)).toBe(0);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      await database?.close();
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      await app?.close();
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, 'C2 application shutdown failed');
  });

  it('creates three persisted fixtures and reads the exact public profile over HTTP', async () => {
    const stored = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: fixtures.target.id });
    const response = await request(app.getHttpServer())
      .get(profilePath())
      .expect(200);
    expect(response.body).toEqual(profile(false));
    expect(response.body.profile).toEqual({
      username: stored.username,
      bio: stored.bio,
      image: stored.image,
      following: false,
    });
    for (const user of [fixtures.actor, fixtures.other])
      expect(
        await dataSource.getRepository(User).existsBy({ id: user.id }),
      ).toBe(true);
    expect(await dataSource.getRepository(Follow).count()).toBe(0);
  });

  it('executes JWT guard, controller and service to persist a Follow visible in the next HTTP read', async () => {
    const response = await request(app.getHttpServer())
      .post(`${profilePath()}/follow`)
      .set('Authorization', `Bearer ${fixtures.token}`)
      .expect(200);
    expect(response.body).toEqual(profile(true));
    expect(await dataSource.getRepository(Follow).find()).toEqual([
      expect.objectContaining({
        followerId: fixtures.actor.id,
        followingId: fixtures.target.id,
      }),
    ]);
    const read = await request(app.getHttpServer())
      .get(profilePath())
      .set('Authorization', `Bearer ${fixtures.token}`)
      .expect(200);
    expect(read.body).toEqual(response.body);
    expect(await dataSource.getRepository(User).count()).toBe(3);
  });

  it('supports explicit fixtures with an existing persisted Follow and unique valid JWTs', async () => {
    await database.truncate();
    const previousToken = fixtures.token;
    fixtures = await createProfileFixtures(
      dataSource,
      app.get(JwtService),
      revocationKeys,
      { following: true },
    );
    expect(fixtures.token).not.toBe(previousToken);
    const read = await request(app.getHttpServer())
      .get(profilePath())
      .set('Authorization', `Bearer ${fixtures.token}`)
      .expect(200);
    expect(read.body).toEqual(profile(true));
    expect(
      await dataSource.getRepository(Follow).countBy({
        followerId: fixtures.actor.id,
        followingId: fixtures.target.id,
      }),
    ).toBe(1);
  });

  it('tracks real logout revocation keys for afterEach cleanup', async () => {
    await request(app.getHttpServer())
      .post('/api/logout')
      .set('Authorization', `Bearer ${fixtures.token}`)
      .expect(204);
    expect(revocationKeys.size).toBe(1);
    expect(await redis.get([...revocationKeys][0])).toBe('1');
    expect(await dataSource.getRepository(User).count()).toBe(3);
  });

  it('truncates the complete application graph and preserves migration history', async () => {
    const article = await dataSource.getRepository(Article).save({
      slug: `c2-${fixtures.actor.id}`,
      title: 'Fixture article',
      description: 'Lifecycle fixture',
      body: 'Fixture body',
      authorId: fixtures.actor.id,
    });
    const tag = await dataSource
      .getRepository(Tag)
      .save({ name: 'c2-fixture' });
    await dataSource.getRepository(ArticleTag).insert({
      articleId: article.id,
      tagId: tag.id,
    });
    await dataSource.getRepository(ArticleFavorite).insert({
      articleId: article.id,
      userId: fixtures.target.id,
    });
    await dataSource.getRepository(Comment).save({
      articleId: article.id,
      authorId: fixtures.other.id,
      body: 'Fixture comment',
    });
    await dataSource.getRepository(Attachment).save({
      attachableType: 'user',
      attachableId: fixtures.actor.id,
      url: '/fixtures/actor.png',
      fileName: 'actor.png',
      fileType: 'image/png',
      fileSize: '100',
    });
    await dataSource.getRepository(Follow).save({
      followerId: fixtures.actor.id,
      followingId: fixtures.target.id,
    });
    expect(
      Object.values(await database.counts()).every((count) => count > 0),
    ).toBe(true);
    await database.truncate();
    expect(await database.counts()).toEqual(emptyCounts);
    expect(await history()).toEqual(migrationHistory);
    expect(await database.assertSession()).toBe(1);
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
      { dropSchema: true },
      { url: 'mysql://unapproved.invalid' },
      { socketPath: '/unapproved.sock' },
      { extra: { host: 'unapproved.invalid' } },
    ];
    for (const unsafe of unsafeOptions)
      expect(() =>
        assertC2DatabaseOptions({
          ...dataSource.options,
          ...unsafe,
        } as DataSourceOptions),
      ).toThrow(C2SafetyError);
    expect(() =>
      assertC2DatabaseOptions(dataSource.options, 'development'),
    ).toThrow(C2SafetyError);
  });

  it('rejects a live connection selecting a different schema without touching fixtures', async () => {
    await database.runner.query('USE information_schema');
    try {
      await expect(database.truncate()).rejects.toThrow(C2SafetyError);
      expect(await dataSource.getRepository(User).count()).toBe(3);
    } finally {
      await database.runner.query(`USE \`${C2_DATABASE}\``);
    }
  });

  it('cannot select the existing shared E2E schema with the dedicated account', async () => {
    await expect(
      database.runner.query('USE `nestjs_tutorial_test`'),
    ).rejects.toMatchObject({
      driverError: { code: 'ER_DBACCESS_DENIED_ERROR' },
    });
    expect(await database.assertSession()).toBe(1);
    expect(await dataSource.getRepository(User).count()).toBe(3);
  });

  it('rejects a second concurrent lifecycle before it can clean this suite fixtures', async () => {
    const second = new C2DatabaseLifecycle(dataSource);
    try {
      await expect(second.start(redis)).rejects.toThrow(
        'Another C2 lifecycle owns this schema',
      );
      expect(await dataSource.getRepository(User).count()).toBe(3);
    } finally {
      await second.close();
    }
  });

  it('restores real session FK checks after a simulated TRUNCATE infrastructure failure', async () => {
    const execute = database.runner.query.bind(database.runner);
    let hasInjectedFailure = false;
    // Only this negative infrastructure test simulates a DB failure. All reads,
    // FK changes and normal lifecycle DDL still execute against real MySQL.
    const query = jest
      .spyOn(database.runner, 'query')
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
      await expect(database.truncate()).rejects.toThrow(
        'C2 TRUNCATE cleanup failed',
      );
      expect(hasInjectedFailure).toBe(true);
      expect(await database.assertSession()).toBe(1);
      expect(await dataSource.getRepository(User).count()).toBe(3);
    } finally {
      query.mockRestore();
    }
  });
});
