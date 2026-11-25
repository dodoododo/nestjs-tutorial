import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { assertC2DatabaseOptions, C2DatabaseLifecycle } from './c2-database';
import {
  C2_DATABASE,
  C2_DATABASE_USER,
  C2_MYSQL_HOST,
  C2_MYSQL_PORT,
  C2_REDIS_HOST,
  C2_REDIS_PORT,
  C2SafetyError,
} from './c2-environment';

function harness() {
  let inventory: unknown = [
    { tableName: 'migrations' },
    { tableName: 'users' },
  ];
  const session = {
    currentDatabase: C2_DATABASE,
    currentUser: `${C2_DATABASE_USER}@%`,
    sessionId: 7,
    lockOwner: 7 as number | null,
    foreignKeyChecks: 1,
  };
  const destroy = jest.fn();
  const runner = {
    isReleased: false,
    isTransactionActive: false,
    connect: jest.fn().mockResolvedValue({ destroy }),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.startsWith('SELECT DATABASE()')) return [session];
      if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
      if (sql.includes('information_schema.tables')) return inventory;
      if (sql.startsWith('SELECT COUNT')) return [{ count: '2' }];
      if (sql.startsWith('SET SESSION'))
        session.foreignKeyChecks = parameters ? Number(parameters[0]) : 0;
      return [];
    }),
  };
  const source = {
    options: {
      type: 'mysql',
      host: C2_MYSQL_HOST,
      port: C2_MYSQL_PORT,
      database: C2_DATABASE,
      username: C2_DATABASE_USER,
      synchronize: false,
      migrationsRun: false,
    },
    createQueryRunner: () => runner,
    showMigrations: jest.fn().mockResolvedValue(false),
  } as unknown as DataSource;
  const redis = {
    options: { host: C2_REDIS_HOST, port: C2_REDIS_PORT, db: 0 },
    ping: jest.fn().mockResolvedValue('PONG'),
  } as unknown as Redis;
  return {
    lifecycle: new C2DatabaseLifecycle(source),
    source,
    runner,
    session,
    redis,
    destroy,
    setInventory: (value: unknown) => {
      inventory = value;
    },
  };
}

describe('C2 dynamic table discovery safety (no external services)', () => {
  it('refuses a different migration ledger before any destructive operation', () => {
    const h = harness();
    expect(() =>
      assertC2DatabaseOptions({
        ...h.source.options,
        migrationsTableName: 'other_ledger',
      }),
    ).toThrow(C2SafetyError);
    expect(h.runner.query).not.toHaveBeenCalled();
  });

  it('rediscovers future tables for both counts and cleanup, excluding migration metadata', async () => {
    const h = harness();
    await h.lifecycle.start(h.redis);
    h.setInventory([
      { tableName: 'migrations' },
      { tableName: 'users' },
      { tableName: 'future_events' },
    ]);
    expect(await h.lifecycle.counts()).toEqual({ users: 2, future_events: 2 });
    h.runner.query.mockClear();
    await h.lifecycle.truncate();
    expect(
      h.runner.query.mock.calls.filter(([sql]) => sql.startsWith('TRUNCATE')),
    ).toEqual([
      [`TRUNCATE TABLE \`${C2_DATABASE}\`.\`users\``],
      [`TRUNCATE TABLE \`${C2_DATABASE}\`.\`future_events\``],
    ]);
    expect(h.runner.query).toHaveBeenCalledWith(
      expect.stringContaining("table_type = 'BASE TABLE'"),
      [C2_DATABASE],
    );
    expect(h.session.foreignKeyChecks).toBe(1);
  });

  it.each(
    [
      [],
      [{ tableName: 'migrations' }],
      [{ tableName: 'users' }],
      [
        { tableName: 'migrations' },
        { tableName: 'users' },
        { tableName: 'users' },
      ],
      ...['users`; DROP DATABASE x; --', 'other.users', '', 'a'.repeat(65)].map(
        (tableName) => [{ tableName: 'migrations' }, { tableName }],
      ),
      [{ tableName: 'migrations' }, null],
      [{ tableName: 'migrations' }, { tableName: 42 }],
      null,
    ].map((inventory) => ({ inventory })),
  )(
    'rejects malformed/incomplete discovery %# before counting or disabling FK checks',
    async ({ inventory }) => {
      const h = harness();
      await h.lifecycle.start(h.redis);
      h.setInventory(inventory);
      h.runner.query.mockClear();
      await expect(h.lifecycle.counts()).rejects.toThrow(C2SafetyError);
      await expect(h.lifecycle.truncate()).rejects.toThrow(C2SafetyError);
      expect(
        h.runner.query.mock.calls.some(([sql]) =>
          /^(TRUNCATE|SET SESSION|SELECT COUNT)/.test(sql),
        ),
      ).toBe(false);
    },
  );

  it.each(['schema', 'account', 'lock', 'transaction', 'released'] as const)(
    'refuses an unsafe live %s before discovery or DDL',
    async (kind) => {
      const h = harness();
      await h.lifecycle.start(h.redis);
      if (kind === 'schema') h.session.currentDatabase = 'nestjs_tutorial_test';
      if (kind === 'account') h.session.currentUser = 'root@localhost';
      if (kind === 'lock') h.session.lockOwner = null;
      if (kind === 'transaction') h.runner.isTransactionActive = true;
      if (kind === 'released') h.runner.isReleased = true;
      h.runner.query.mockClear();
      await expect(h.lifecycle.truncate()).rejects.toThrow(C2SafetyError);
      expect(
        h.runner.query.mock.calls.every(([sql]) =>
          sql.startsWith('SELECT DATABASE()'),
        ),
      ).toBe(true);
    },
  );

  it.each([0, 1])(
    'restores original FK state %i even when truncation fails',
    async (original) => {
      const h = harness();
      await h.lifecycle.start(h.redis);
      h.session.foreignKeyChecks = original;
      const execute = h.runner.query.getMockImplementation()!;
      h.runner.query.mockImplementation(async (sql, parameters) => {
        if (sql.startsWith('TRUNCATE')) throw new Error('DDL unavailable');
        return execute(sql, parameters);
      });
      await expect(h.lifecycle.truncate()).rejects.toThrow(
        'C2 TRUNCATE cleanup failed',
      );
      expect(h.session.foreignKeyChecks).toBe(original);
    },
  );

  it('reports DDL and FK restoration failures and discards the unsafe physical connection', async () => {
    const h = harness();
    await h.lifecycle.start(h.redis);
    const execute = h.runner.query.getMockImplementation()!;
    const ddl = new Error('DDL unavailable');
    const restore = new Error('FK restoration unavailable');
    h.runner.query.mockImplementation(async (sql, parameters) => {
      if (sql.startsWith('TRUNCATE')) throw ddl;
      if (sql.startsWith('SET SESSION') && parameters) throw restore;
      return execute(sql, parameters);
    });
    await expect(h.lifecycle.truncate()).rejects.toMatchObject({
      errors: [ddl, restore],
    });
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });
});
