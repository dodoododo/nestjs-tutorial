import type { JwtService, JwtSignOptions } from '@nestjs/jwt';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { INVALID_USER_PASSWORD_HASH } from '../../../src/auth/constants/auth.constant';
import { Follow } from '../../../src/database/entities/follow.entity';
import { User } from '../../../src/database/entities/user.entity';
import { REVOCATION_KEY_PREFIX } from '../../../src/redis/redis.constant';
import { assertC2DatabaseOptions, assertC2Redis } from './c2-database';
import { C2SafetyError } from './c2-environment';

const c2RevocationPrefix = `${REVOCATION_KEY_PREFIX}pr6-c2:`;

export async function issueC2Token(
  jwt: JwtService,
  userId: string,
  revocationKeys: Set<string>,
  options: JwtSignOptions = {},
  claims: Record<string, unknown> = {},
): Promise<string> {
  const jti = `pr6-c2:${randomUUID()}`;
  const payload = { sub: userId, tokenVersion: 0, jti, ...claims };
  // Track the final claim, including explicitly malformed negative fixtures.
  // Register before signing so failed initialization cannot lose cleanup state.
  if (typeof payload.jti === 'string') {
    if (!payload.jti.startsWith('pr6-c2:'))
      throw new C2SafetyError('Refusing to issue a non-C2 token');
    revocationKeys.add(`${REVOCATION_KEY_PREFIX}${payload.jti}`);
  }
  return jwt.signAsync(payload, options);
}

export async function createProfileFixtures(
  dataSource: DataSource,
  jwt: JwtService,
  revocationKeys: Set<string>,
  options: { following?: boolean } = {},
) {
  assertC2DatabaseOptions(dataSource.options);
  const users = dataSource.getRepository(User);
  const [actor, target, other] = await users.save(
    users.create(
      ['actor', 'target', 'other'].map((role) => {
        const id = randomUUID();
        return {
          id,
          username: `c2_${role}_${id}`,
          email: `c2_${role}_${id}@example.test`,
          passwordHash: INVALID_USER_PASSWORD_HASH,
          tokenVersion: 0,
          bio: `${role} biography`,
          image: `/fixtures/${role}.png`,
        };
      }),
    ),
  );
  if (options.following)
    await dataSource.getRepository(Follow).insert({
      followerId: actor.id,
      followingId: target.id,
    });
  return {
    actor,
    target,
    other,
    token: await issueC2Token(
      jwt,
      actor.id,
      revocationKeys,
      {},
      { tokenVersion: actor.tokenVersion },
    ),
  };
}

export async function cleanC2RedisKeys(
  redis: Redis,
  revocationKeys: Set<string>,
): Promise<void> {
  assertC2Redis(redis);
  if ([...revocationKeys].some((key) => !key.startsWith(c2RevocationPrefix)))
    throw new C2SafetyError('Refusing to delete a non-C2 Redis key');
  if (revocationKeys.size) await redis.del(...revocationKeys);
  revocationKeys.clear();
}
