import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type { PoolConnection } from 'mysql2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import request from 'supertest';
import { QueryFailedError, type QueryRunner } from 'typeorm';
import { Follow } from '../../src/database/entities/follow.entity';
import { User } from '../../src/database/entities/user.entity';
import {
  REDIS_UNAVAILABLE_MESSAGE,
  REVOCATION_KEY_PREFIX,
} from '../../src/redis/redis.constant';
import { C2_DATABASE, C2SafetyError } from './helpers/c2-environment';
import { issueC2Token } from './helpers/profile-fixtures';

import { setupC2Suite } from './helpers/setup-c2-suite';

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
  const suite = setupC2Suite();
  const publicProfile = (following: boolean) => ({
    profile: {
      username: suite.fixtures.target.username,
      bio: suite.fixtures.target.bio,
      image: suite.fixtures.target.image,
      following,
    },
  });

  function send(
    method: Method,
    authorization?: string,
    username = suite.fixtures.target.username,
  ) {
    const suffix = method === 'get' ? '' : '/follow';
    const req = request(suite.app.getHttpServer())[method](
      `/api/profiles/${encodeURIComponent(username)}${suffix}`,
    );
    if (authorization !== undefined) req.set('Authorization', authorization);
    return req;
  }

  async function snapshot() {
    const users = await suite.dataSource.getRepository(User).find({
      select: {
        id: true,
        username: true,
        email: true,
        passwordHash: true,
        tokenVersion: true,
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
      follows: await suite.dataSource
        .getRepository(Follow)
        .find({ order: { id: 'ASC' } }),
      counts: await suite.database.counts(),
    };
  }

  async function seedRelations(includeTarget: boolean) {
    const pairs = [
      {
        followerId: suite.fixtures.actor.id,
        followingId: suite.fixtures.other.id,
      },
      {
        followerId: suite.fixtures.other.id,
        followingId: suite.fixtures.target.id,
      },
      {
        followerId: suite.fixtures.target.id,
        followingId: suite.fixtures.actor.id,
      },
    ];
    if (includeTarget)
      pairs.push({
        followerId: suite.fixtures.actor.id,
        followingId: suite.fixtures.target.id,
      });
    await suite.dataSource.getRepository(Follow).insert(pairs);
    expect(await suite.dataSource.getRepository(Follow).count()).toBe(
      pairs.length,
    );
  }

  const signToken = (options: JwtSignOptions = {}) =>
    issueC2Token(
      suite.app.get(JwtService),
      suite.fixtures.actor.id,
      suite.revocationKeys,
      options,
    );

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
    const response = await send('get', `Bearer ${suite.fixtures.token}`).expect(
      200,
    );
    expect(response.body).toEqual(publicProfile(true));
    expect(await snapshot()).toEqual(before);
  });

  it('[G03] returns following=false without the actor-target relation', async () => {
    const before = await snapshot();
    const response = await send('get', `Bearer ${suite.fixtures.token}`).expect(
      200,
    );
    expect(response.body).toEqual(publicProfile(false));
    expect(await snapshot()).toEqual(before);
  });

  it('[G04] does not reverse the stored Follow direction', async () => {
    await seedRelations(false);
    const before = await snapshot();
    const response = await send('get', `Bearer ${suite.fixtures.token}`).expect(
      200,
    );
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
        authenticated ? `Bearer ${suite.fixtures.token}` : undefined,
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
    await suite.dataSource
      .getRepository(User)
      .update(suite.fixtures.target.id, { bio: null, image: null });
    suite.fixtures.target.bio = null;
    suite.fixtures.target.image = null;
    const before = await snapshot();
    const response = await send('get').expect(200);
    expect(response.body).toEqual(publicProfile(false));
    expect(await snapshot()).toEqual(before);
  });

  it('[G08] serves anonymous profiles without querying unavailable Redis verification', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const get = jest
      .spyOn(suite.redis, 'get')
      .mockRejectedValue(new C2SafetyError('Simulated Redis outage'));
    const response = await send('get').expect(200);
    expect(response.body).toEqual(publicProfile(false));
    expect(get).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('[F01] inserts exactly one actor-target Follow and preserves unrelated rows', async () => {
    await seedRelations(false);
    const before = await snapshot();
    const response = await send(
      'post',
      `Bearer ${suite.fixtures.token}`,
    ).expect(200);
    expect(response.body).toEqual(publicProfile(true));
    const created = await suite.dataSource
      .getRepository(Follow)
      .findOneByOrFail({
        followerId: suite.fixtures.actor.id,
        followingId: suite.fixtures.target.id,
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
          followerId === suite.fixtures.target.id &&
          followingId === suite.fixtures.actor.id,
      ),
    ).toHaveLength(1);
    expect(
      await suite.dataSource.getRepository(Follow).countBy({
        followerId: suite.fixtures.actor.id,
        followingId: suite.fixtures.target.id,
      }),
    ).toBe(1);
  });

  it.each([
    { id: 'F02', uppercase: false },
    { id: 'F03', uppercase: true },
  ])('[$id] rejects self-follow before insertion', async ({ uppercase }) => {
    const before = await snapshot();
    const username = uppercase
      ? suite.fixtures.actor.username.toUpperCase()
      : suite.fixtures.actor.username;
    const response = await send(
      'post',
      `Bearer ${suite.fixtures.token}`,
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
      `Bearer ${suite.fixtures.token}`,
      `missing_${randomUUID()}`,
    ).expect(404);
    expect(response.body).toEqual({
      message: 'Profile not found',
      error: 'Not Found',
      statusCode: 404,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('[F05] handles the real duplicate constraint idempotently and retains exactly one relation', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const response = await send(
      'post',
      `Bearer ${suite.fixtures.token}`,
    ).expect(200);
    expect(response.body).toEqual(publicProfile(true));
    expect(await snapshot()).toEqual(before);
    expect(
      await suite.dataSource.getRepository(Follow).countBy({
        followerId: suite.fixtures.actor.id,
        followingId: suite.fixtures.target.id,
      }),
    ).toBe(1);
  });

  it('[F06] handles concurrent duplicate HTTP requests as 200/200 with one persisted edge', async () => {
    const before = await snapshot();
    const responses = await Promise.all([
      send('post', `Bearer ${suite.fixtures.token}`),
      send('post', `Bearer ${suite.fixtures.token}`),
    ]);
    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual(
      [200, 200],
    );
    for (const response of responses)
      expect(response.body).toEqual(publicProfile(true));
    const after = await snapshot();
    expect(after.users).toBe(before.users);
    expect(after.counts).toEqual({ ...before.counts, follows: 1 });
    expect(after.follows).toEqual([
      expect.objectContaining({
        followerId: suite.fixtures.actor.id,
        followingId: suite.fixtures.target.id,
      }),
    ]);
  });

  it('[F07] ignores forged body/query ownership and uses only the JWT actor and path target', async () => {
    const before = await snapshot();
    const response = await send('post', `Bearer ${suite.fixtures.token}`)
      .query({
        followerId: suite.fixtures.other.id,
        followingId: suite.fixtures.other.id,
      })
      .send({
        userId: suite.fixtures.other.id,
        followerId: suite.fixtures.other.id,
        followingId: suite.fixtures.other.id,
      })
      .expect(200);
    expect(response.body).toEqual(publicProfile(true));
    const after = await snapshot();
    expect(after.users).toBe(before.users);
    expect(after.counts).toEqual({ ...before.counts, follows: 1 });
    expect(after.follows).toEqual([
      expect.objectContaining({
        followerId: suite.fixtures.actor.id,
        followingId: suite.fixtures.target.id,
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
      const prototype = Object.getPrototypeOf(
        suite.database.runner,
      ) as QueryRunner;
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
              .spyOn(suite.dataSource.driver, 'obtainMasterConnection')
              .mockRejectedValueOnce(
                new C2SafetyError('Simulated connection acquisition outage'),
              );
          }
          try {
            return await Reflect.apply(execute, this, [
              sql,
              parameters,
              structured,
            ]);
          } catch (error: unknown) {
            observedError = error;
            throw error;
          }
        }
        return Reflect.apply(execute, this, [sql, parameters, structured]);
      });
      try {
        const response = await send(
          'post',
          `Bearer ${suite.fixtures.token}`,
        ).expect(500);
        expect(response.body).toEqual({
          statusCode: 500,
          message: 'Internal server error',
        });
        expect(hasInjectedFailure).toBe(true);
        if (kind === 'closed-connection') {
          expect(observedError).toBeInstanceOf(QueryFailedError);
          expect(
            (observedError as QueryFailedError<Error & { code?: string }>)
              .driverError.code,
          ).not.toBe('ER_DUP_ENTRY');
        } else expect(observedError).toBeInstanceOf(C2SafetyError);
      } finally {
        query.mockRestore();
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it('[F10] propagates a real duplicate from a different unique index without changing relationships', async () => {
    await seedRelations(false);
    const before = await snapshot();
    const runner = suite.database.runner;
    let isIndexCreated = false;
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await suite.database.assertSession();
    try {
      await runner.query(
        `CREATE UNIQUE INDEX c2_other_follow_unique ON \`${C2_DATABASE}\`.\`follows\` (follower_id)`,
      );
      isIndexCreated = true;
      const response = await send(
        'post',
        `Bearer ${suite.fixtures.token}`,
      ).expect(500);
      expect(response.body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
      expect(await snapshot()).toEqual(before);
    } finally {
      if (isIndexCreated) {
        await suite.database.assertSession();
        await runner.query(
          `DROP INDEX c2_other_follow_unique ON \`${C2_DATABASE}\`.\`follows\``,
        );
      }
    }
  });

  it('[U01] deletes only actor-target and preserves target, reverse and unrelated rows', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const response = await send(
      'delete',
      `Bearer ${suite.fixtures.token}`,
    ).expect(200);
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
            followerId === suite.fixtures.actor.id &&
            followingId === suite.fixtures.target.id
          ),
      ),
    );
  });

  it('[U02] succeeds when actor-target is absent without deleting any other relationship', async () => {
    await seedRelations(false);
    const before = await snapshot();
    const response = await send(
      'delete',
      `Bearer ${suite.fixtures.token}`,
    ).expect(200);
    expect(response.body).toEqual(publicProfile(false));
    expect(await snapshot()).toEqual(before);
  });

  it('[U03] returns 404 for a missing target without deleting any relationship', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const response = await send(
      'delete',
      `Bearer ${suite.fixtures.token}`,
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
    const first = await send('delete', `Bearer ${suite.fixtures.token}`).expect(
      200,
    );
    expect(first.body).toEqual(publicProfile(false));
    const afterFirst = await snapshot();
    expect(afterFirst.users).toBe(before.users);
    expect(afterFirst.follows).toEqual(
      before.follows.filter(
        ({ followerId, followingId }) =>
          !(
            followerId === suite.fixtures.actor.id &&
            followingId === suite.fixtures.target.id
          ),
      ),
    );
    expect(afterFirst.counts).toEqual({
      ...before.counts,
      follows: before.counts.follows - 1,
    });
    const second = await send(
      'delete',
      `Bearer ${suite.fixtures.token}`,
    ).expect(200);
    expect(second.body).toEqual(first.body);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it('[U05] cannot delete a forged independent-user relationship', async () => {
    await seedRelations(true);
    const before = await snapshot();
    const response = await send('delete', `Bearer ${suite.fixtures.token}`)
      .query({
        followerId: suite.fixtures.other.id,
        followingId: suite.fixtures.other.id,
      })
      .send({
        userId: suite.fixtures.other.id,
        followerId: suite.fixtures.other.id,
        followingId: suite.fixtures.other.id,
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
            followerId === suite.fixtures.actor.id &&
            followingId === suite.fixtures.target.id
          ),
      ),
    );
  });

  it.each(authenticationCases)(
    '[$id] rejects credentials/dependency failure before any profile mutation',
    async ({ method, kind }) => {
      await seedRelations(method !== 'post');
      let authorization: string | undefined = `Bearer ${suite.fixtures.token}`;
      if (kind === 'missing') authorization = undefined;
      if (kind === 'malformed') authorization = 'Bearer';
      if (kind === 'invalid') authorization = 'Bearer not-a-jwt';
      if (kind === 'wrong-signature')
        authorization = `Bearer ${await signToken({ secret: randomBytes(32).toString('hex') })}`;
      if (kind === 'expired')
        authorization = `Bearer ${await signToken({ expiresIn: -1 })}`;
      if (kind === 'revoked') {
        const { jti } = suite.app
          .get(JwtService)
          .decode<{ jti: string }>(suite.fixtures.token);
        await suite.redis.set(`${REVOCATION_KEY_PREFIX}${jti}`, '1', 'EX', 60);
        expect(await suite.redis.get(`${REVOCATION_KEY_PREFIX}${jti}`)).toBe(
          '1',
        );
      }
      if (kind === 'deleted-user')
        await suite.dataSource
          .getRepository(User)
          .delete(suite.fixtures.actor.id);
      if (kind === 'redis-get-outage') {
        jest
          .spyOn(suite.redis, 'get')
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
        const ended = once(suite.redis, 'end');
        suite.restoreInfrastructure = async () => {
          await ended;
          await suite.redis.connect();
        };
        suite.redis.disconnect();
        await ended;
        expect(suite.redis.status).toBe('end');
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
    { id: 'J05', kind: 'negative-version' },
    { id: 'J06', kind: 'fractional-version' },
    { id: 'J07', kind: 'string-version' },
    { id: 'J08', kind: 'unsafe-version' },
    { id: 'J09', kind: 'null-version' },
  ])(
    '[$id] independently rejects an invalid signed atomic JWT claim',
    async ({ kind }) => {
      const payload: Record<string, unknown> = {
        sub: suite.fixtures.actor.id,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      if (kind === 'sub') payload.sub = 42;
      if (kind === 'jti') payload.jti = 42;
      if (kind === 'missing-exp') delete payload.exp;
      if (kind === 'fractional-exp') payload.exp = Number(payload.exp) + 0.5;
      if (kind === 'negative-version') payload.tokenVersion = -1;
      if (kind === 'fractional-version') payload.tokenVersion = 0.5;
      if (kind === 'string-version') payload.tokenVersion = '0';
      if (kind === 'null-version') payload.tokenVersion = null;
      if (kind === 'unsafe-version')
        payload.tokenVersion = Number.MAX_SAFE_INTEGER + 1;
      // A real Nest JWT signer without default expiry is used only to construct
      // deliberately invalid claims. The application's real guards verify them.
      const signer = new JwtService({
        secret: suite.app.get(ConfigService).getOrThrow<string>('JWT_SECRET'),
      });
      const token = await issueC2Token(
        signer,
        suite.fixtures.actor.id,
        suite.revocationKeys,
        {},
        payload,
      );
      expect(signer.decode(token)).toMatchObject(payload);
      // Prove library verification accepts these signed claims before the HTTP
      // strategy rejects the individual application-level condition.
      expect(await suite.app.get(JwtService).verifyAsync(token)).toMatchObject(
        payload,
      );
      if (kind === 'missing-exp')
        expect(signer.decode(token)).not.toHaveProperty('exp');
      const before = await snapshot();
      const get = jest.spyOn(suite.redis, 'get');
      const response = await send('get', `Bearer ${token}`).expect(401);
      expect(response.body).toEqual({
        message: 'Unauthorized',
        statusCode: 401,
      });
      expect(get).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    { id: 'V01', persistedVersion: 0, tokenVersion: undefined, status: 200 },
    { id: 'V02', persistedVersion: 1, tokenVersion: undefined, status: 401 },
    { id: 'V03', persistedVersion: 1, tokenVersion: 0, status: 401 },
    { id: 'V04', persistedVersion: 1, tokenVersion: 1, status: 200 },
  ])(
    '[$id] validates legacy and current tokens against the persisted token version',
    async ({ persistedVersion, tokenVersion, status }) => {
      await suite.dataSource
        .getRepository(User)
        .update(suite.fixtures.actor.id, { tokenVersion: persistedVersion });
      const token = await issueC2Token(
        suite.app.get(JwtService),
        suite.fixtures.actor.id,
        suite.revocationKeys,
        {},
        { tokenVersion },
      );
      const before = await snapshot();
      const response = await send('get', `Bearer ${token}`).expect(status);
      expect(response.body).toEqual(
        status === 200
          ? publicProfile(false)
          : { message: 'Unauthorized', statusCode: 401 },
      );
      expect(await snapshot()).toEqual(before);
    },
  );
});
