import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import type { PoolConnection } from 'mysql2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import request from 'supertest';
import { DataSource, QueryFailedError, type QueryRunner } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { setupCommentBodyParser } from '../../src/comments/comment-body-parser';
import { Follow } from '../../src/database/entities/follow.entity';
import { User } from '../../src/database/entities/user.entity';
import {
  REDIS_CLIENT,
  REDIS_UNAVAILABLE_MESSAGE,
  REVOCATION_KEY_PREFIX,
} from '../../src/redis/redis.constant';
import { C2DatabaseLifecycle, C2_TABLES } from './helpers/c2-database';
import { C2SafetyError } from './helpers/c2-environment';
import {
  cleanC2RedisKeys,
  createProfileFixtures,
} from './helpers/profile-fixtures';

type Method = 'get' | 'post' | 'delete';
const methods: Method[] = ['get', 'post', 'delete'];
const authenticationKinds = [
  'missing',
  'malformed',
  'invalid',
  'wrong-signature',
  'expired',
  'revoked',
  'deleted-user',
  'redis-get-outage',
  'redis-disconnected',
] as const;
const authenticationCases = methods.flatMap((method) =>
  authenticationKinds
    .filter((kind) => !(method === 'get' && kind === 'missing'))
    .map((kind) => ({ id: `A-${method.toUpperCase()}-${kind}`, method, kind })),
);

describe('ProfilesController C2 conditions', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let database: C2DatabaseLifecycle;
  let fixtures: Awaited<ReturnType<typeof createProfileFixtures>>;
  let migrationHistory: unknown;
  let isLifecycleReady = false;
  let restoreInfrastructure: (() => Promise<void>) | undefined;
  const revocationKeys = new Set<string>();
  const previousIds: string[] = [];
  const previousKeys: string[] = [];
  const emptyCounts = Object.fromEntries(C2_TABLES.map((table) => [table, 0]));

  const history = (): Promise<unknown> =>
    dataSource.query('SELECT id, timestamp, name FROM migrations ORDER BY id');
  const publicProfile = (following: boolean) => ({
    profile: {
      username: fixtures.target.username,
      bio: fixtures.target.bio,
      image: fixtures.target.image,
      following,
    },
  });

  function send(
    method: Method,
    authorization?: string,
    username = fixtures.target.username,
  ) {
    const suffix = method === 'get' ? '' : '/follow';
    const req = request(app.getHttpServer())[method](
      `/api/profiles/${encodeURIComponent(username)}${suffix}`,
    );
    if (authorization !== undefined) req.set('Authorization', authorization);
    return req;
  }

  async function snapshot() {
    const users = await dataSource.getRepository(User).find({
      select: {
        id: true,
        username: true,
        email: true,
        passwordHash: true,
        bio: true,
        image: true,
        createdAt: true,
        updatedAt: true,
      },
      order: { id: 'ASC' },
    });
    return {
      // Failed assertions must not dump private User columns into test logs.
      users: createHash('sha256').update(JSON.stringify(users)).digest('hex'),
      follows: await dataSource
        .getRepository(Follow)
        .find({ order: { id: 'ASC' } }),
      counts: await database.counts(),
    };
  }

  async function seedRelations(includeTarget: boolean) {
    const pairs = [
      { followerId: fixtures.actor.id, followingId: fixtures.other.id },
      { followerId: fixtures.other.id, followingId: fixtures.target.id },
      { followerId: fixtures.target.id, followingId: fixtures.actor.id },
    ];
    if (includeTarget)
      pairs.push({
        followerId: fixtures.actor.id,
        followingId: fixtures.target.id,
      });
    await dataSource.getRepository(Follow).insert(pairs);
    expect(await dataSource.getRepository(Follow).count()).toBe(pairs.length);
  }

  function trackJti(): string {
    const jti = `pr6-c2:${randomUUID()}`;
    revocationKeys.add(`${REVOCATION_KEY_PREFIX}${jti}`);
    return jti;
  }

  const signToken = (options: JwtSignOptions = {}) =>
    app
      .get(JwtService)
      .signAsync({ sub: fixtures.actor.id, jti: trackJti() }, options);

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
    if (!isLifecycleReady) return;
    const errors: unknown[] = [];
    try {
      await restoreInfrastructure?.();
    } catch (error: unknown) {
      errors.push(error);
    } finally {
      restoreInfrastructure = undefined;
    }
    previousIds.splice(
      0,
      previousIds.length,
      fixtures.actor.id,
      fixtures.target.id,
      fixtures.other.id,
    );
    previousKeys.splice(0, previousKeys.length, ...revocationKeys);
    const outcomes = await Promise.allSettled([
      database.truncate(),
      cleanC2RedisKeys(redis, revocationKeys),
    ]);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') errors.push(outcome.reason);
    if (errors.length)
      throw new AggregateError(errors, 'Profiles C2 teardown failed');
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
      throw new AggregateError(errors, 'Profiles C2 shutdown failed');
  });

  it('[G01] returns the exact public anonymous profile even when a Follow exists', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const response = await send('get').expect(200);
    expect(response.body).toEqual(publicProfile(false));
    expect(await snapshot()).toEqual(before);
  });

  it('[G02] returns following=true only for the authenticated actor relation', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const response = await send('get', `Bearer ${fixtures.token}`).expect(200);
    expect(response.body).toEqual(publicProfile(true));
    expect(await snapshot()).toEqual(before);
  });

  it('[G03] returns following=false without the actor-target relation', async () => {
    const before = await snapshot();
    const response = await send('get', `Bearer ${fixtures.token}`).expect(200);
    expect(response.body).toEqual(publicProfile(false));
    expect(await snapshot()).toEqual(before);
  });

  it('[G04] does not reverse the stored Follow direction', async () => {
    await seedRelations(false);
    const before = await snapshot();
    const response = await send('get', `Bearer ${fixtures.token}`).expect(200);
    expect(response.body).toEqual(publicProfile(false));
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { id: 'G05', authenticated: false },
    { id: 'G06', authenticated: true },
  ])(
    '[$id] rejects an unknown profile without changing persisted state',
    async ({ authenticated }) => {
      const before = await snapshot();
      const response = await send(
        'get',
        authenticated ? `Bearer ${fixtures.token}` : undefined,
        `missing_${randomUUID()}`,
      ).expect(404);
      expect(response.body).toEqual({
        message: 'Profile not found',
        error: 'Not Found',
        statusCode: 404,
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it('[G07] preserves null public fields without leaking private fields', async () => {
    await dataSource
      .getRepository(User)
      .update(fixtures.target.id, { bio: null, image: null });
    fixtures.target.bio = null;
    fixtures.target.image = null;
    const before = await snapshot();
    const response = await send('get').expect(200);
    expect(response.body).toEqual(publicProfile(false));
    expect(await snapshot()).toEqual(before);
  });

  it('[G08] serves anonymous profiles without querying unavailable Redis verification', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const get = jest
      .spyOn(redis, 'get')
      .mockRejectedValue(new C2SafetyError('Simulated Redis outage'));
    const response = await send('get').expect(200);
    expect(response.body).toEqual(publicProfile(false));
    expect(get).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('[F01] inserts exactly one actor-target Follow and preserves unrelated rows', async () => {
    await seedRelations(false);
    const before = await snapshot();
    const response = await send('post', `Bearer ${fixtures.token}`).expect(200);
    expect(response.body).toEqual(publicProfile(true));
    const created = await dataSource.getRepository(Follow).findOneByOrFail({
      followerId: fixtures.actor.id,
      followingId: fixtures.target.id,
    });
    const after = await snapshot();
    expect(after.users).toBe(before.users);
    expect(after.counts).toEqual({
      ...before.counts,
      follows: before.counts.follows + 1,
    });
    expect(after.follows.filter(({ id }) => id !== created.id)).toEqual(
      before.follows,
    );
    // The reverse relation was pre-existing; POST creates no additional reverse.
    expect(
      after.follows.filter(
        ({ followerId, followingId }) =>
          followerId === fixtures.target.id &&
          followingId === fixtures.actor.id,
      ),
    ).toHaveLength(1);
    expect(
      await dataSource.getRepository(Follow).countBy({
        followerId: fixtures.actor.id,
        followingId: fixtures.target.id,
      }),
    ).toBe(1);
  });

  it.each([
    { id: 'F02', uppercase: false },
    { id: 'F03', uppercase: true },
  ])('[$id] rejects self-follow before insertion', async ({ uppercase }) => {
    const before = await snapshot();
    const username = uppercase
      ? fixtures.actor.username.toUpperCase()
      : fixtures.actor.username;
    const response = await send(
      'post',
      `Bearer ${fixtures.token}`,
      username,
    ).expect(400);
    expect(response.body).toEqual({
      message: 'You cannot follow yourself',
      error: 'Bad Request',
      statusCode: 400,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('[F04] returns 404 for an unknown target without inserting a Follow', async () => {
    await seedRelations(false);
    const before = await snapshot();
    const response = await send(
      'post',
      `Bearer ${fixtures.token}`,
      `missing_${randomUUID()}`,
    ).expect(404);
    expect(response.body).toEqual({
      message: 'Profile not found',
      error: 'Not Found',
      statusCode: 404,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('[F05] maps the real duplicate constraint to 409 and retains exactly one relation', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const response = await send('post', `Bearer ${fixtures.token}`).expect(409);
    expect(response.body).toEqual({
      message: 'You are already following this user',
      error: 'Conflict',
      statusCode: 409,
    });
    expect(await snapshot()).toEqual(before);
    expect(
      await dataSource.getRepository(Follow).countBy({
        followerId: fixtures.actor.id,
        followingId: fixtures.target.id,
      }),
    ).toBe(1);
  });

  it('[F06] handles concurrent duplicate HTTP requests as 200/409 with one persisted edge', async () => {
    const before = await snapshot();
    const responses = await Promise.all([
      send('post', `Bearer ${fixtures.token}`),
      send('post', `Bearer ${fixtures.token}`),
    ]);
    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual(
      [200, 409],
    );
    expect(responses.find(({ status }) => status === 200)!.body).toEqual(
      publicProfile(true),
    );
    expect(responses.find(({ status }) => status === 409)!.body).toEqual({
      message: 'You are already following this user',
      error: 'Conflict',
      statusCode: 409,
    });
    const after = await snapshot();
    expect(after.users).toBe(before.users);
    expect(after.counts).toEqual({ ...before.counts, follows: 1 });
    expect(after.follows).toEqual([
      expect.objectContaining({
        followerId: fixtures.actor.id,
        followingId: fixtures.target.id,
      }),
    ]);
  });

  it('[F07] ignores forged body/query ownership and uses only the JWT actor and path target', async () => {
    const before = await snapshot();
    const response = await send('post', `Bearer ${fixtures.token}`)
      .query({ followerId: fixtures.other.id, followingId: fixtures.other.id })
      .send({
        userId: fixtures.other.id,
        followerId: fixtures.other.id,
        followingId: fixtures.other.id,
      })
      .expect(200);
    expect(response.body).toEqual(publicProfile(true));
    const after = await snapshot();
    expect(after.users).toBe(before.users);
    expect(after.counts).toEqual({ ...before.counts, follows: 1 });
    expect(after.follows).toEqual([
      expect.objectContaining({
        followerId: fixtures.actor.id,
        followingId: fixtures.target.id,
      }),
    ]);
  });

  it.each([
    { id: 'F08', kind: 'closed-connection' },
    { id: 'F09', kind: 'connection-acquisition' },
  ] as const)(
    '[$id] sanitizes a specifically unavailable MySQL dependency without a partial Follow',
    async ({ kind }) => {
      await seedRelations(false);
      const before = await snapshot();
      const prototype = Object.getPrototypeOf(database.runner) as QueryRunner;
      const query = jest.spyOn(prototype, 'query');
      const execute = query.getMockImplementation()!;
      let hasInjectedFailure = false;
      let observedError: unknown;
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      // Infrastructure-only fault injection. Repositories, service and all SQL
      // results remain real. Target just the request's Follow INSERT connection.
      query.mockImplementation(async function (
        this: QueryRunner,
        sql: string,
        parameters?: unknown[],
        structured?: boolean,
      ) {
        if (!hasInjectedFailure && sql.startsWith('INSERT INTO `follows`')) {
          hasInjectedFailure = true;
          if (kind === 'closed-connection') {
            const connection = (await this.connect()) as PoolConnection;
            connection.destroy();
          } else {
            jest
              .spyOn(dataSource.driver, 'obtainMasterConnection')
              .mockRejectedValueOnce(
                new C2SafetyError('Simulated connection acquisition outage'),
              );
          }
          try {
            return await execute.call(this, sql, parameters, structured);
          } catch (error: unknown) {
            observedError = error;
            throw error;
          }
        }
        return execute.call(this, sql, parameters, structured);
      });
      try {
        const response = await send('post', `Bearer ${fixtures.token}`).expect(
          500,
        );
        expect(response.body).toEqual({
          statusCode: 500,
          message: 'Internal server error',
        });
        expect(hasInjectedFailure).toBe(true);
        if (kind === 'closed-connection') {
          expect(observedError).toBeInstanceOf(QueryFailedError);
          expect((observedError as QueryFailedError).driverError.code).not.toBe(
            'ER_DUP_ENTRY',
          );
        } else expect(observedError).toBeInstanceOf(C2SafetyError);
      } finally {
        query.mockRestore();
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it('[U01] deletes only actor-target and preserves target, reverse and unrelated rows', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const response = await send('delete', `Bearer ${fixtures.token}`).expect(
      200,
    );
    expect(response.body).toEqual(publicProfile(false));
    const after = await snapshot();
    expect(after.users).toBe(before.users);
    expect(after.counts).toEqual({
      ...before.counts,
      follows: before.counts.follows - 1,
    });
    expect(after.follows).toEqual(
      before.follows.filter(
        ({ followerId, followingId }) =>
          !(
            followerId === fixtures.actor.id &&
            followingId === fixtures.target.id
          ),
      ),
    );
  });

  it('[U02] succeeds when actor-target is absent without deleting any other relationship', async () => {
    await seedRelations(false);
    const before = await snapshot();
    const response = await send('delete', `Bearer ${fixtures.token}`).expect(
      200,
    );
    expect(response.body).toEqual(publicProfile(false));
    expect(await snapshot()).toEqual(before);
  });

  it('[U03] returns 404 for a missing target without deleting any relationship', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const response = await send(
      'delete',
      `Bearer ${fixtures.token}`,
      `missing_${randomUUID()}`,
    ).expect(404);
    expect(response.body).toEqual({
      message: 'Profile not found',
      error: 'Not Found',
      statusCode: 404,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('[U04] keeps the second DELETE idempotent and state unchanged', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const first = await send('delete', `Bearer ${fixtures.token}`).expect(200);
    expect(first.body).toEqual(publicProfile(false));
    const afterFirst = await snapshot();
    expect(afterFirst.users).toBe(before.users);
    expect(afterFirst.follows).toEqual(
      before.follows.filter(
        ({ followerId, followingId }) =>
          !(
            followerId === fixtures.actor.id &&
            followingId === fixtures.target.id
          ),
      ),
    );
    expect(afterFirst.counts).toEqual({
      ...before.counts,
      follows: before.counts.follows - 1,
    });
    const second = await send('delete', `Bearer ${fixtures.token}`).expect(200);
    expect(second.body).toEqual(first.body);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it('[U05] cannot delete a forged independent-user relationship', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const response = await send('delete', `Bearer ${fixtures.token}`)
      .query({ followerId: fixtures.other.id, followingId: fixtures.other.id })
      .send({
        userId: fixtures.other.id,
        followerId: fixtures.other.id,
        followingId: fixtures.other.id,
      })
      .expect(200);
    expect(response.body).toEqual(publicProfile(false));
    const after = await snapshot();
    expect(after.users).toBe(before.users);
    expect(after.counts).toEqual({
      ...before.counts,
      follows: before.counts.follows - 1,
    });
    expect(after.follows).toEqual(
      before.follows.filter(
        ({ followerId, followingId }) =>
          !(
            followerId === fixtures.actor.id &&
            followingId === fixtures.target.id
          ),
      ),
    );
  });

  it.each(authenticationCases)(
    '[$id] rejects credentials/dependency failure before any profile mutation',
    async ({ method, kind }) => {
      await seedRelations(method !== 'post');
      let authorization: string | undefined = `Bearer ${fixtures.token}`;
      if (kind === 'missing') authorization = undefined;
      if (kind === 'malformed') authorization = 'Bearer';
      if (kind === 'invalid') authorization = 'Bearer not-a-jwt';
      if (kind === 'wrong-signature')
        authorization = `Bearer ${await signToken({ secret: randomBytes(32).toString('hex') })}`;
      if (kind === 'expired')
        authorization = `Bearer ${await signToken({ expiresIn: -1 })}`;
      if (kind === 'revoked') {
        const { jti } = app
          .get(JwtService)
          .decode<{ jti: string }>(fixtures.token);
        await redis.set(`${REVOCATION_KEY_PREFIX}${jti}`, '1', 'EX', 60);
        expect(await redis.get(`${REVOCATION_KEY_PREFIX}${jti}`)).toBe('1');
      }
      if (kind === 'deleted-user')
        await dataSource.getRepository(User).delete(fixtures.actor.id);
      if (kind === 'redis-get-outage') {
        jest
          .spyOn(redis, 'get')
          .mockRejectedValueOnce(
            new C2SafetyError('Simulated Redis GET outage'),
          );
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
      }
      if (kind === 'redis-disconnected') {
        // disconnect() closes asynchronously. Wait for the actual end event,
        // rather than assuming its status changes synchronously.
        const ended = once(redis, 'end');
        restoreInfrastructure = async () => {
          await ended;
          await redis.connect();
        };
        redis.disconnect();
        await ended;
        expect(redis.status).toBe('end');
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
      }
      const before = await snapshot();
      const isUnavailable =
        kind === 'redis-get-outage' || kind === 'redis-disconnected';
      const response = await send(method, authorization).expect(
        isUnavailable ? 503 : 401,
      );
      expect(response.body).toEqual(
        isUnavailable
          ? {
              message: REDIS_UNAVAILABLE_MESSAGE,
              error: 'Service Unavailable',
              statusCode: 503,
            }
          : { message: 'Unauthorized', statusCode: 401 },
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    { id: 'J01', kind: 'sub' },
    { id: 'J02', kind: 'jti' },
    { id: 'J03', kind: 'missing-exp' },
    { id: 'J04', kind: 'fractional-exp' },
  ])(
    '[$id] independently rejects an invalid signed atomic JWT claim',
    async ({ kind }) => {
      const payload: Record<string, unknown> = {
        sub: fixtures.actor.id,
        jti: trackJti(),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      if (kind === 'sub') payload.sub = 42;
      if (kind === 'jti') payload.jti = 42;
      if (kind === 'missing-exp') delete payload.exp;
      if (kind === 'fractional-exp') payload.exp = Number(payload.exp) + 0.5;
      // A real Nest JWT signer without default expiry is used only to construct
      // deliberately invalid claims. The application's real guards verify them.
      const signer = new JwtService({
        secret: app.get(ConfigService).getOrThrow<string>('JWT_SECRET'),
      });
      const token = await signer.signAsync(payload);
      expect(signer.decode(token)).toMatchObject(payload);
      // Prove library verification accepts these signed claims before the HTTP
      // strategy rejects the individual application-level condition.
      expect(await app.get(JwtService).verifyAsync(token)).toMatchObject(
        payload,
      );
      if (kind === 'missing-exp')
        expect(signer.decode(token)).not.toHaveProperty('exp');
      const before = await snapshot();
      const get = jest.spyOn(redis, 'get');
      const response = await send('get', `Bearer ${token}`).expect(401);
      expect(response.body).toEqual({
        message: 'Unauthorized',
        statusCode: 401,
      });
      expect(get).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    },
  );
});
