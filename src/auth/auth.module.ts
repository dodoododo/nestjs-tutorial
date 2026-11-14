import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../database/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ThrottlerModule } from '@nestjs/throttler';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RedisModule } from '../redis/redis.module';
import { LogoutController } from './logout.controller';
import { LogoutService } from './logout.service';

@Module({
  imports: [
    RedisModule,
    PassportModule.register({
      defaultStrategy: 'jwt',
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 5,
      },
    ]),
    TypeOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.getOrThrow<string>('JWT_SECRET');
        const expiresIn = Number(config.getOrThrow<string>('JWT_TTL_SECONDS'));

        if (Buffer.byteLength(secret, 'utf8') < 32) {
          throw new Error('JWT_SECRET must be at least 32 bytes');
        }

        if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
          throw new Error('JWT_TTL_SECONDS must be positive');
        }

        return {
          secret,
          signOptions: { expiresIn },
        };
      },
    }),
  ],
  controllers: [AuthController, LogoutController],
  providers: [AuthService, JwtStrategy, LogoutService],
  exports: [AuthService],
})
export class AuthModule {}
