import type Redis from 'ioredis';
import type { PoolConnection } from 'mysql2';
import type { DataSource, DataSourceOptions, QueryRunner } from 'typeorm';
import {
  C2_DATABASE,
  C2_DATABASE_USER,
  C2_MYSQL_HOST,
  C2_MYSQL_PORT,
  C2_REDIS_HOST,
  C2_REDIS_PORT,
  C2SafetyError,
} from './c2-environment';

const lockName = `${C2_DATABASE}:lifecycle`;

export function assertC2DatabaseOptions(
  options: DataSourceOptions,
  nodeEnvironment = process.env.NODE_ENV,
): void {
  if (
    nodeEnvironment !== 'test' ||
    options.type !== 'mysql' ||
    options.host !== C2_MYSQL_HOST ||
    options.port !== C2_MYSQL_PORT ||
    options.database !== C2_DATABASE ||
    options.username !== C2_DATABASE_USER ||
    options.synchronize !== false ||
    options.migrationsRun !== false ||
    (options.migrationsTableName !== undefined &&
      options.migrationsTableName !== 'migrations') ||
    options.dropSchema === true ||
    options.url !== undefined ||
    options.replication !== undefined ||
    options.socketPath !== undefined ||
    options.extra !== undefined
  )
    throw new C2SafetyError('Refusing unsafe C2 database configuration');
}

export function assertC2Redis(redis: Redis): void {
  if (
    process.env.NODE_ENV !== 'test' ||
    redis.options.host !== C2_REDIS_HOST ||
    redis.options.port !== C2_REDIS_PORT ||
    redis.options.db !== 0 ||
    redis.options.keyPrefix
  )
    throw new C2SafetyError('Refusing unsafe C2 Redis configuration');
}

export class C2DatabaseLifecycle {
  readonly runner: QueryRunner;
  private hasLock = false;

  constructor(private readonly dataSource: DataSource) {
    assertC2DatabaseOptions(dataSource.options);
    this.runner = dataSource.createQueryRunner();
  }

  async start(redis: Redis): Promise<void> {
    assertC2Redis(redis);
    await redis.ping();
    await this.runner.connect();
    await this.assertSession(false);
    const [{ acquired }] = (await this.runner.query(
      'SELECT GET_LOCK(?, 0) AS acquired',
      [lockName],
    )) as { acquired: number | string | null }[];
    if (Number(acquired) !== 1)
      throw new C2SafetyError('Another C2 lifecycle owns this schema');
    this.hasLock = true;
    await this.applicationTables();
    if (await this.dataSource.showMigrations())
      throw new C2SafetyError('Run npm run test:c2:setup before C2 tests');
    await this.truncate();
  }

  async assertSession(requireLock = true): Promise<number> {
    assertC2DatabaseOptions(this.dataSource.options);
    if (this.runner.isReleased || this.runner.isTransactionActive)
      throw new C2SafetyError(
        'C2 cleanup requires an open nontransactional session',
      );
    const [session] = (await this.runner.query(
      'SELECT DATABASE() AS currentDatabase, CURRENT_USER() AS currentUser, CONNECTION_ID() AS sessionId, IS_USED_LOCK(?) AS lockOwner, @@SESSION.foreign_key_checks AS foreignKeyChecks',
      [lockName],
    )) as {
      currentDatabase: string;
      currentUser: string;
      sessionId: number | string;
      lockOwner: number | string | null;
      foreignKeyChecks: number | string;
    }[];
    if (
      !session ||
      session.currentDatabase !== C2_DATABASE ||
      typeof session.currentUser !== 'string' ||
      session.currentUser.split('@')[0] !== C2_DATABASE_USER ||
      (requireLock &&
        (!this.hasLock ||
          String(session.lockOwner) !== String(session.sessionId))) ||
      ![0, 1, '0', '1'].includes(session.foreignKeyChecks)
    )
      throw new C2SafetyError(
        'Live C2 session failed schema/lease verification',
      );
    return Number(session.foreignKeyChecks);
  }

  private async applicationTables(): Promise<string[]> {
    await this.assertSession();
    const tables = (await this.runner.query(
      "SELECT TABLE_NAME AS tableName FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY TABLE_NAME",
      [C2_DATABASE],
    )) as { tableName: string }[];
    if (
      !Array.isArray(tables) ||
      tables.length < 2 ||
      tables.some(
        (row) =>
          !row ||
          typeof row.tableName !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(row.tableName),
      ) ||
      new Set(tables.map(({ tableName }) => tableName)).size !==
        tables.length ||
      !tables.some(({ tableName }) => tableName === 'migrations')
    )
      throw new C2SafetyError('Invalid or empty C2 base-table inventory');
    return tables
      .map(({ tableName }) => tableName)
      .filter((table) => table !== 'migrations');
  }

  async counts(): Promise<Record<string, number>> {
    const counts: [string, number][] = [];
    for (const table of await this.applicationTables()) {
      const [{ count }] = (await this.runner.query(
        `SELECT COUNT(*) AS count FROM \`${C2_DATABASE}\`.\`${table}\``,
      )) as { count: string }[];
      counts.push([table, Number(count)]);
    }
    return Object.fromEntries(counts);
  }

  async truncate(): Promise<void> {
    const previousForeignKeyChecks = await this.assertSession();
    const tables = await this.applicationTables();
    const errors: unknown[] = [];
    try {
      await this.runner.query('SET SESSION FOREIGN_KEY_CHECKS = 0');
      for (const table of tables) {
        // Validate the same physical connection immediately before each DDL.
        await this.assertSession();
        await this.runner.query(
          `TRUNCATE TABLE \`${C2_DATABASE}\`.\`${table}\``,
        );
      }
    } catch (error: unknown) {
      errors.push(error);
    } finally {
      try {
        await this.runner.query('SET SESSION FOREIGN_KEY_CHECKS = ?', [
          previousForeignKeyChecks,
        ]);
      } catch (error: unknown) {
        errors.push(error);
        // Never return a connection with unknown FK state to the app's pool.
        try {
          const connection = (await this.runner.connect()) as PoolConnection;
          connection.destroy();
        } catch (discardError: unknown) {
          errors.push(discardError);
        }
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'C2 TRUNCATE cleanup failed');
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    try {
      if (this.hasLock)
        await this.runner.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      await this.runner.release();
    } catch (error: unknown) {
      errors.push(error);
    } finally {
      this.hasLock = false;
    }
    if (errors.length)
      throw new AggregateError(errors, 'C2 database shutdown failed');
  }
}
