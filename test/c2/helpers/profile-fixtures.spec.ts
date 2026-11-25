import { JwtService } from '@nestjs/jwt';
import type Redis from 'ioredis';
import { REVOCATION_KEY_PREFIX } from '../../../src/redis/redis.constant';
import { C2_REDIS_HOST, C2_REDIS_PORT } from './c2-environment';
import { cleanC2RedisKeys, issueC2Token } from './profile-fixtures';

describe('C2 token and Redis tracking', () => {
  const jwt = new JwtService({
    secret: 'unit-test-secret-with-at-least-32-bytes',
    signOptions: { expiresIn: 60 },
  });

  it('tracks each unique real token once, with current version and signing options', async () => {
    const keys = new Set<string>();
    const first = await issueC2Token(jwt, 'actor', keys);
    const expired = await issueC2Token(jwt, 'actor', keys, { expiresIn: -1 });
    const claims = jwt.decode<{
      sub: string;
      jti: string;
      tokenVersion: number;
    }>(first);
    expect(claims).toMatchObject({ sub: 'actor', tokenVersion: 0 });
    expect(keys).toEqual(
      new Set(
        [claims.jti, jwt.decode<{ jti: string }>(expired).jti].map(
          (jti) => `${REVOCATION_KEY_PREFIX}${jti}`,
        ),
      ),
    );
    expect(keys.size).toBe(2);
    await expect(jwt.verifyAsync(first)).resolves.toMatchObject(claims);
    await expect(jwt.verifyAsync(expired)).rejects.toThrow('jwt expired');
  });

  it('tracks the actual overridden JTI and supports deliberately malformed claims', async () => {
    const keys = new Set<string>();
    const token = await issueC2Token(
      jwt,
      'actor',
      keys,
      {},
      { jti: 'pr6-c2:override', tokenVersion: -1 },
    );
    expect(jwt.decode(token)).toMatchObject({
      jti: 'pr6-c2:override',
      tokenVersion: -1,
    });
    expect([...keys]).toEqual([`${REVOCATION_KEY_PREFIX}pr6-c2:override`]);
    const invalid = await issueC2Token(jwt, 'actor', keys, {}, { jti: 42 });
    expect(jwt.decode(invalid)).toMatchObject({ jti: 42 });
    expect(keys.size).toBe(1);
    await expect(
      issueC2Token(jwt, 'actor', keys, {}, { jti: 'unrelated' }),
    ).rejects.toThrow('non-C2 token');
  });

  it('registers cleanup state before signing fails', async () => {
    const keys = new Set<string>();
    const failure = new Error('signing failed');
    const signer = {
      signAsync: jest.fn().mockRejectedValue(failure),
    } as unknown as JwtService;
    await expect(issueC2Token(signer, 'actor', keys)).rejects.toBe(failure);
    expect(keys.size).toBe(1);
  });

  it('retains tracked keys when deletion fails and never deletes unrelated keys', async () => {
    const del = jest
      .fn()
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockResolvedValue(1);
    const redis = {
      options: { host: C2_REDIS_HOST, port: C2_REDIS_PORT, db: 0 },
      del,
    } as unknown as Redis;
    const key = `${REVOCATION_KEY_PREFIX}pr6-c2:tracked`;
    const keys = new Set([key]);
    await expect(cleanC2RedisKeys(redis, keys)).rejects.toThrow(
      'Redis unavailable',
    );
    expect([...keys]).toEqual([key]);
    keys.add('unrelated');
    await expect(cleanC2RedisKeys(redis, keys)).rejects.toThrow(
      'non-C2 Redis key',
    );
    expect(del).toHaveBeenCalledTimes(1);
    keys.delete('unrelated');
    await cleanC2RedisKeys(redis, keys);
    expect(del).toHaveBeenLastCalledWith(key);
    expect(keys.size).toBe(0);
  });
});
