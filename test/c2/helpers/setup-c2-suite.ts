import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../src/app.module';
import { configureHttpApplication } from '../../../src/configure-http-application';
import { Follow } from '../../../src/database/entities/follow.entity';
import { User } from '../../../src/database/entities/user.entity';
import { REDIS_CLIENT } from '../../../src/redis/redis.constant';
import { C2DatabaseLifecycle } from './c2-database';
import { C2SafetyError } from './c2-environment';
import { cleanC2RedisKeys, createProfileFixtures } from './profile-fixtures';

type Fixtures = Awaited<ReturnType<typeof createProfileFixtures>>;

/** Register inside describe; getters always expose the current case's fixtures. */
export function setupC2Suite() {
  let moduleRef: TestingModule | undefined;
  let app: NestExpressApplication | undefined;
  let dataSource: DataSource | undefined;
  let redis: Redis | undefined;
  let database: C2DatabaseLifecycle | undefined;
  let fixtures: Fixtures | undefined;
  let migrationHistory: unknown;
  let emptyCounts: Record<string, number> = {};
  let isLifecycleReady = false;
  let restoreInfrastructure: (() => Promise<void>) | undefined;
  const revocationKeys = new Set<string>();
  const previousIds: string[] = [];
  const previousKeys: string[] = [];

  function ready<T>(value: T | undefined): T {
    if (value === undefined)
      throw new C2SafetyError('C2 suite resource is not initialized');
    return value;
  }

  const history = (): Promise<unknown> =>
    ready(dataSource).query(
      'SELECT id, timestamp, name FROM migrations ORDER BY id',
    );

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApplication(app);
    await app.init();
    dataSource = app.get(DataSource);
    redis = app.get<Redis>(REDIS_CLIENT);
    database = new C2DatabaseLifecycle(ready(dataSource));
    await database.start(redis);
    migrationHistory = await history();
    emptyCounts = Object.fromEntries(
      Object.keys(await database.counts()).map((table) => [table, 0]),
    );
    expect(await database.counts()).toEqual(emptyCounts);
    isLifecycleReady = true;
  });

  beforeEach(async () => {
    // Reset before any assertion/await: failed initialization must never reuse
    // the preceding case's fixtures or dereference an unassigned fixture.
    fixtures = undefined;
    expect(await ready(database).counts()).toEqual(emptyCounts);
    for (const id of previousIds)
      expect(await ready(dataSource).getRepository(User).existsBy({ id })).toBe(
        false,
      );
    for (const key of previousKeys)
      expect(await ready(redis).exists(key)).toBe(0);
    fixtures = await createProfileFixtures(
      ready(dataSource),
      ready(app).get(JwtService),
      revocationKeys,
    );
    expect(await ready(dataSource).getRepository(User).count()).toBe(3);
    expect(await ready(dataSource).getRepository(Follow).count()).toBe(0);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // No destructive cleanup when isolation/migration preflight did not finish.
    if (!isLifecycleReady) return;
    const errors: unknown[] = [];
    try {
      await restoreInfrastructure?.();
    } catch (error: unknown) {
      errors.push(error);
    } finally {
      restoreInfrastructure = undefined;
    }
    previousIds.splice(0, previousIds.length);
    if (fixtures)
      previousIds.push(
        fixtures.actor.id,
        fixtures.target.id,
        fixtures.other.id,
      );
    fixtures = undefined;
    previousKeys.splice(0, previousKeys.length, ...revocationKeys);
    const outcomes = await Promise.allSettled([
      ready(database).truncate(),
      cleanC2RedisKeys(ready(redis), revocationKeys),
    ]);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') errors.push(outcome.reason);
    if (errors.length) throw new AggregateError(errors, 'C2 teardown failed');
    expect(await ready(database).counts()).toEqual(emptyCounts);
    expect(await ready(database).assertSession()).toBe(1);
    expect(await history()).toEqual(migrationHistory);
    for (const key of previousKeys)
      expect(await ready(redis).exists(key)).toBe(0);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      await database?.close();
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      // The compiled module still needs closing if application creation failed.
      if (app) await app.close();
      else await moduleRef?.close();
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'C2 shutdown failed');
  });

  return {
    get app() {
      return ready(app);
    },
    get dataSource() {
      return ready(dataSource);
    },
    get redis() {
      return ready(redis);
    },
    get database() {
      return ready(database);
    },
    get fixtures() {
      return ready(fixtures);
    },
    set fixtures(value: Fixtures) {
      fixtures = value;
    },
    get emptyCounts() {
      return emptyCounts;
    },
    get migrationHistory() {
      return migrationHistory;
    },
    set restoreInfrastructure(restore: (() => Promise<void>) | undefined) {
      restoreInfrastructure = restore;
    },
    revocationKeys,
    history,
  };
}
