import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { REDIS_CLIENT, REVOCATION_KEY_PREFIX } from './redis.constant';
import { RedisService } from './redis.service';

describe('RedisService', () => {
  let service: RedisService;

  const client = {
    status: 'ready',
    get: jest.fn(),
    set: jest.fn(),
    disconnect: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    client.status = 'ready';

    const moduleRef = await Test.createTestingModule({
      providers: [
        RedisService,
        {
          provide: REDIS_CLIENT,
          useValue: client,
        },
      ],
    }).compile();

    service = moduleRef.get(RedisService);
  });

  it('returns false when the token is not revoked', async () => {
    client.get.mockResolvedValue(null);

    await expect(service.isTokenRevoked('test-jti')).resolves.toBe(false);

    expect(client.get).toHaveBeenCalledWith(`${REVOCATION_KEY_PREFIX}test-jti`);
  });

  it('returns true when the token is revoked', async () => {
    client.get.mockResolvedValue('1');

    await expect(service.isTokenRevoked('test-jti')).resolves.toBe(true);
  });

  it('stores revocation with remaining JWT TTL', async () => {
    client.set.mockResolvedValue('OK');

    const expiresAt = Math.floor(Date.now() / 1000) + 300;

    await service.revokeToken('test-jti', expiresAt);

    expect(client.set).toHaveBeenCalledWith(
      `${REVOCATION_KEY_PREFIX}test-jti`,
      '1',
      'EX',
      expect.any(Number),
    );

    const ttl = client.set.mock.calls[0][3] as number;

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('does not store already expired tokens', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 1;

    await service.revokeToken('expired-jti', expiresAt);

    expect(client.set).not.toHaveBeenCalled();
  });

  it('fails closed when Redis is disconnected', async () => {
    client.status = 'reconnecting';

    await expect(service.isTokenRevoked('test-jti')).rejects.toThrow(
      ServiceUnavailableException,
    );

    expect(client.get).not.toHaveBeenCalled();
  });

  it('returns 503 when Redis reads fail', async () => {
    client.get.mockRejectedValue(new Error('Connection lost'));

    await expect(service.isTokenRevoked('test-jti')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('returns 503 when Redis writes fail', async () => {
    client.set.mockRejectedValue(new Error('Connection lost'));

    await expect(
      service.revokeToken('test-jti', Math.floor(Date.now() / 1000) + 300),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('disconnects Redis on module shutdown', () => {
    service.onModuleDestroy();

    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});
