import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';

import { User } from '../../database/entities/user.entity';
import type { AuthenticatedPrincipal } from '../interfaces/authenticated-request.interface';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly redisService: RedisService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
      passReqToCallback: true,
    });
  }

  async validate(
    request: Request,
    payload: JwtPayload,
  ): Promise<AuthenticatedPrincipal> {
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.jti !== 'string' ||
      !Number.isInteger(payload.exp)
    ) {
      throw new UnauthorizedException();
    }

    if (await this.redisService.isTokenRevoked(payload.jti)) {
      throw new UnauthorizedException();
    }

    const user = await this.usersRepository.findOneBy({
      id: payload.sub,
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(request);

    if (!token) {
      throw new UnauthorizedException();
    }

    return {
      user,
      token,
      jti: payload.jti,
      exp: payload.exp,
    };
  }
}
