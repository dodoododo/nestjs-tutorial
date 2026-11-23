import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Repository } from 'typeorm';

import { User } from '../../database/entities/user.entity';
import { RedisService } from '../../redis/redis.service';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy token version and revocation security', () => {
  const repository = { findOneBy: jest.fn() };
  const redis = { isTokenRevoked: jest.fn() };
  const request = {
    headers: { authorization: 'Bearer signed-token' },
  } as Request;
  const payload: JwtPayload = {
    sub: 'user-id',
    jti: 'token-id',
    exp: 2000000000,
    tokenVersion: 0,
  };
  let strategy: JwtStrategy;

  beforeEach(() => {
    jest.resetAllMocks();
    repository.findOneBy.mockResolvedValue({ id: 'user-id', tokenVersion: 0 });
    redis.isTokenRevoked.mockResolvedValue(false);
    strategy = new JwtStrategy(
      new ConfigService({
        JWT_SECRET: 'test-secret-with-at-least-32-characters',
      }),
      repository as unknown as Repository<User>,
      redis as unknown as RedisService,
    );
  });

  it('accepts a matching version and retains logout claims', async () => {
    expect(await strategy.validate(request, payload)).toEqual({
      user: { id: 'user-id', tokenVersion: 0 },
      token: 'signed-token',
      jti: payload.jti,
      exp: payload.exp,
    });
    expect(redis.isTokenRevoked).toHaveBeenCalledWith(payload.jti);
  });

  it('accepts an absent version only before the first password change', async () => {
    const { tokenVersion: _version, ...legacy } = payload;
    await expect(strategy.validate(request, legacy)).resolves.toBeDefined();
    repository.findOneBy.mockResolvedValue({ id: 'user-id', tokenVersion: 1 });
    await expect(strategy.validate(request, legacy)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([0, 1, 3])(
    'rejects stale or future version %i against stored version 2',
    async (tokenVersion) => {
      repository.findOneBy.mockResolvedValue({
        id: 'user-id',
        tokenVersion: 2,
      });
      await expect(
        strategy.validate(request, { ...payload, tokenVersion }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it.each([
    null,
    '0',
    -1,
    0.5,
    true,
    {},
    [],
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
  ])(
    'rejects malformed version %# before DB or Redis access',
    async (tokenVersion) => {
      await expect(
        strategy.validate(request, { ...payload, tokenVersion } as JwtPayload),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(repository.findOneBy).not.toHaveBeenCalled();
      expect(redis.isTokenRevoked).not.toHaveBeenCalled();
    },
  );

  it('accepts the current version after a password change', async () => {
    repository.findOneBy.mockResolvedValue({ id: 'user-id', tokenVersion: 2 });
    await expect(
      strategy.validate(request, { ...payload, tokenVersion: 2 }),
    ).resolves.toBeDefined();
  });

  it('still rejects a revoked JTI with a matching version', async () => {
    redis.isTokenRevoked.mockResolvedValue(true);
    await expect(strategy.validate(request, payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(repository.findOneBy).not.toHaveBeenCalled();
  });

  it('fails closed when Redis is unavailable', async () => {
    const failure = new ServiceUnavailableException();
    redis.isTokenRevoked.mockRejectedValue(failure);
    await expect(strategy.validate(request, payload)).rejects.toBe(failure);
    expect(repository.findOneBy).not.toHaveBeenCalled();
  });

  it('rejects deleted users', async () => {
    repository.findOneBy.mockResolvedValue(null);
    await expect(strategy.validate(request, payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
