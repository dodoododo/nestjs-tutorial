import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import Redis from 'ioredis';

import {
  REDIS_CLIENT,
  REDIS_UNAVAILABLE_MESSAGE,
  REVOCATION_KEY_PREFIX,
} from './redis.constant';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly client: Redis,
  ) {}

  async isTokenRevoked(jti: string): Promise<boolean> {
    this.assertReady();

    try {
      const value = await this.client.get(this.createRevocationKey(jti));

      return value !== null;
    } catch {
      this.throwUnavailable();
    }
  }

  async revokeToken(jti: string, expiresAt: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const remainingSeconds = expiresAt - now;

    if (!Number.isSafeInteger(expiresAt) || remainingSeconds <= 0) {
      return;
    }

    this.assertReady();

    try {
      await this.client.set(
        this.createRevocationKey(jti),
        '1',
        'EX',
        remainingSeconds,
      );
    } catch {
      this.throwUnavailable();
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }

  private createRevocationKey(jti: string): string {
    return `${REVOCATION_KEY_PREFIX}${jti}`;
  }

  private assertReady(): void {
    if (this.client.status !== 'ready') {
      this.throwUnavailable();
    }
  }

  private throwUnavailable(): never {
    this.logger.warn('Redis revocation check unavailable');

    throw new ServiceUnavailableException(REDIS_UNAVAILABLE_MESSAGE);
  }
}
