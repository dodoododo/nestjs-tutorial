import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { C2DatabaseLifecycle } from './c2-database';
import { cleanC2RedisKeys, createProfileFixtures } from './profile-fixtures';
import { setupC2Suite } from './setup-c2-suite';

jest.mock('../../../src/app.module', () => ({ AppModule: class {} }));
jest.mock('../../../src/configure-http-application', () => ({
  configureHttpApplication: jest.fn(),
}));
jest.mock('./c2-database', () => ({ C2DatabaseLifecycle: jest.fn() }));
jest.mock('./profile-fixtures', () => ({
  createProfileFixtures: jest.fn(),
  cleanC2RedisKeys: jest.fn(),
}));

function harness() {
  const hooks = {} as Record<
    'beforeAll' | 'beforeEach' | 'afterEach' | 'afterAll',
    () => Promise<void>
  >;
  const registrations = (
    ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'] as const
  ).map((name) =>
    jest.spyOn(global, name).mockImplementation((fn) => {
      hooks[name] = fn as () => Promise<void>;
    }),
  );
  const suite = setupC2Suite();
  registrations.forEach((spy) => spy.mockRestore());
  const database = {
    start: jest.fn().mockResolvedValue(undefined),
    counts: jest.fn().mockResolvedValue({ users: 0, follows: 0 }),
    truncate: jest.fn().mockResolvedValue(undefined),
    assertSession: jest.fn().mockResolvedValue(1),
    close: jest.fn().mockResolvedValue(undefined),
  };
  jest
    .mocked(C2DatabaseLifecycle)
    .mockImplementation(() => database as unknown as C2DatabaseLifecycle);
  const source = {
    query: jest.fn().mockResolvedValue([{ id: 1, name: 'migration' }]),
    getRepository: jest.fn().mockReturnValue({
      existsBy: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(3),
    }),
  };
  // User and Follow repositories have different fixture-count invariants.
  source.getRepository.mockImplementation((entity) => ({
    existsBy: jest.fn().mockResolvedValue(false),
    count: jest.fn().mockResolvedValue(entity.name === 'User' ? 3 : 0),
  }));
  const redis = { exists: jest.fn().mockResolvedValue(0) };
  const app = {
    init: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    get: jest.fn((token) =>
      token === DataSource ? source : token === JwtService ? {} : redis,
    ),
  };
  const moduleRef = {
    createNestApplication: jest.fn().mockReturnValue(app),
    close: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(Test, 'createTestingModule').mockReturnValue({
    compile: jest.fn().mockResolvedValue(moduleRef),
  } as unknown as ReturnType<typeof Test.createTestingModule>);
  const fixtures = {
    actor: { id: 'actor' },
    target: { id: 'target' },
    other: { id: 'other' },
    token: 'token',
  } as Awaited<ReturnType<typeof createProfileFixtures>>;
  jest.mocked(createProfileFixtures).mockResolvedValue(fixtures);
  jest.mocked(cleanC2RedisKeys).mockImplementation(async (_redis, keys) => {
    keys.clear();
  });
  return { suite, hooks, database, app, source, moduleRef, fixtures };
}

describe('shared C2 hooks (no external services)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetAllMocks();
  });

  it('cleans partial first-case initialization without a secondary fixture TypeError', async () => {
    const h = harness();
    await h.hooks.beforeAll();
    const original = new Error('fixture signing failed after rows were saved');
    jest
      .mocked(createProfileFixtures)
      .mockImplementation(async (_source, _jwt, keys) => {
        keys.add('auth:revoked:pr6-c2:partial');
        throw original;
      });
    await expect(h.hooks.beforeEach()).rejects.toBe(original);
    await expect(h.hooks.afterEach()).resolves.toBeUndefined();
    expect(h.database.truncate).toHaveBeenCalledTimes(1);
    expect(cleanC2RedisKeys).toHaveBeenCalledTimes(1);
    expect(h.suite.revocationKeys.size).toBe(0);
    await h.hooks.afterAll();
    expect(h.database.close).toHaveBeenCalledTimes(1);
    expect(h.app.close).toHaveBeenCalledTimes(1);
  });

  it('clears stale fixtures before a later failed initialization and still cleans both stores', async () => {
    const h = harness();
    await h.hooks.beforeAll();
    await h.hooks.beforeEach();
    await h.hooks.afterEach();
    jest
      .mocked(createProfileFixtures)
      .mockRejectedValueOnce(new Error('next fixture failed'));
    await expect(h.hooks.beforeEach()).rejects.toThrow('next fixture failed');
    expect(() => h.suite.fixtures).toThrow('not initialized');
    await expect(h.hooks.afterEach()).resolves.toBeUndefined();
    expect(h.database.truncate).toHaveBeenCalledTimes(2);
  });

  it('restores disconnected infrastructure before Redis cleanup', async () => {
    const h = harness();
    await h.hooks.beforeAll();
    await h.hooks.beforeEach();
    const events: string[] = [];
    h.suite.restoreInfrastructure = async () => {
      events.push('restore');
    };
    jest.mocked(cleanC2RedisKeys).mockImplementation(async () => {
      events.push('redis');
    });
    await h.hooks.afterEach();
    expect(events).toEqual(['restore', 'redis']);
    await h.hooks.afterEach();
    expect(events).toEqual(['restore', 'redis', 'redis']);
  });

  it('aggregates restoration and both cleanup failures while still closing resources', async () => {
    const h = harness();
    await h.hooks.beforeAll();
    await h.hooks.beforeEach();
    const restore = new Error('restore');
    const db = new Error('database');
    const redis = new Error('Redis');
    h.suite.restoreInfrastructure = async () => {
      throw restore;
    };
    h.database.truncate.mockRejectedValueOnce(db);
    jest.mocked(cleanC2RedisKeys).mockRejectedValueOnce(redis);
    await expect(h.hooks.afterEach()).rejects.toMatchObject({
      errors: [restore, db, redis],
    });
    await h.hooks.afterAll();
    expect(h.database.close).toHaveBeenCalled();
    expect(h.app.close).toHaveBeenCalled();
  });

  it('skips destructive per-case teardown when database preflight failed', async () => {
    const h = harness();
    h.database.start.mockRejectedValueOnce(new Error('unsafe schema'));
    await expect(h.hooks.beforeAll()).rejects.toThrow('unsafe schema');
    await h.hooks.afterEach();
    expect(h.database.truncate).not.toHaveBeenCalled();
    expect(cleanC2RedisKeys).not.toHaveBeenCalled();
    await h.hooks.afterAll();
    expect(h.database.close).toHaveBeenCalled();
    expect(h.app.close).toHaveBeenCalled();
  });

  it('closes the compiled module when creating the HTTP application fails', async () => {
    const h = harness();
    h.moduleRef.createNestApplication.mockImplementationOnce(() => {
      throw new Error('create app');
    });
    await expect(h.hooks.beforeAll()).rejects.toThrow('create app');
    await h.hooks.afterAll();
    expect(h.moduleRef.close).toHaveBeenCalledTimes(1);
  });

  it('attempts application shutdown even if database shutdown fails', async () => {
    const h = harness();
    await h.hooks.beforeAll();
    const db = new Error('database shutdown');
    const app = new Error('application shutdown');
    h.database.close.mockRejectedValueOnce(db);
    h.app.close.mockRejectedValueOnce(app);
    await expect(h.hooks.afterAll()).rejects.toMatchObject({
      errors: [db, app],
    });
  });
});
