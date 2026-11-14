import { Injectable } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';

@Injectable()
export class LogoutService {
  constructor(private readonly redisService: RedisService) {}

  logout(jti: string, expiresAt: number): Promise<void> {
    return this.redisService.revokeToken(jti, expiresAt);
  }
}
