import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { RedisService } from '../redis/redis.service';
import { LogoutService } from './logout.service';

describe('LogoutService', () => {
  let service: LogoutService;

  const redisService = {
    revokeToken: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        LogoutService,
        {
          provide: RedisService,
          useValue: redisService,
        },
      ],
    }).compile();

    service = moduleRef.get(LogoutService);
  });

  it('revokes the current JWT by jti and exp', async () => {
    const jti = 'test-jti';
    const exp = Math.floor(Date.now() / 1000) + 3600;

    redisService.revokeToken.mockResolvedValue(undefined);

    await expect(service.logout(jti, exp)).resolves.toBeUndefined();

    expect(redisService.revokeToken).toHaveBeenCalledWith(jti, exp);
  });

  it('propagates Redis failure without reporting success', async () => {
    redisService.revokeToken.mockRejectedValue(
      new ServiceUnavailableException('Authentication temporarily unavailable'),
    );

    await expect(
      service.logout('test-jti', Math.floor(Date.now() / 1000) + 3600),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
