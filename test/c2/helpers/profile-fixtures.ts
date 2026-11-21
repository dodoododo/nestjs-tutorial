import type { JwtService } from '@nestjs/jwt';
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
): Promise<string> {
  const jti = `pr6-c2:${randomUUID()}`;
  revocationKeys.add(`${REVOCATION_KEY_PREFIX}${jti}`);
  return jwt.signAsync({ sub: userId, jti });
}

export async function createProfileFixtures(
  dataSource: DataSource,
  jwt: JwtService,
  revocationKeys: Set<string>,
  options: { following?: boolean } = {},
) {
  assertC2DatabaseOptions(dataSource.options);
  const [actor, target, other] = await dataSource.getRepository(User).save(
    ['actor', 'target', 'other'].map((role) => {
      const id = randomUUID();
      return {
        id,
        username: `c2_${role}_${id}`,
        email: `c2_${role}_${id}@example.test`,
        passwordHash: INVALID_USER_PASSWORD_HASH,
        bio: `${role} biography`,
        image: `/fixtures/${role}.png`,
      };
    }),
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
    token: await issueC2Token(jwt, actor.id, revocationKeys),
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
