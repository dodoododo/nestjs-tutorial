import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { REDIS_CLIENT } from './redis.constant';
import { RedisService } from './redis.service';

const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const host = config.getOrThrow<string>('REDIS_HOST');
    const password = config.getOrThrow<string>('REDIS_PASSWORD');

    const port = Number(config.getOrThrow<string>('REDIS_PORT'));

    if (!host.trim()) {
      throw new Error('REDIS_HOST must not be empty');
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('REDIS_PORT must be a valid TCP port');
    }

    if (password.length < 16) {
      throw new Error('REDIS_PASSWORD must be at least 16 characters');
    }

    const logger = new Logger('RedisConnection');

    const client = new Redis({
      host,
      port,
      password,
      enableReadyCheck: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 1500,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    });

    client.on('ready', () => {
      logger.log('Redis connection ready');
    });

    client.on('error', () => {
      logger.warn('Redis connection unavailable');
    });

    return client;
  },
};

@Module({
  imports: [ConfigModule],
  providers: [redisClientProvider, RedisService],
  exports: [RedisService],
})
export class RedisModule {}
