import { ConflictException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { hash } from 'bcrypt';
import { I18nService } from 'nestjs-i18n';
import { QueryFailedError, Repository } from 'typeorm';

import { User } from '../database/entities/user.entity';
import { BCRYPT_SALT_ROUNDS } from './constants/auth.constant';
import { RegisterDto } from './dto/register.dto';
import { UserResponseDto } from './dto/user-response.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly i18n: I18nService,
  ) {}

  async register(dto: RegisterDto): Promise<UserResponseDto> {
    const passwordHash = await hash(dto.password, BCRYPT_SALT_ROUNDS);

    const user = this.usersRepository.create({
      username: dto.username.trim(),
      email: dto.email.toLowerCase(),
      passwordHash,
      bio: null,
      image: null,
    });

    try {
      await this.usersRepository.save(user);
    } catch (error: unknown) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === 'ER_DUP_ENTRY'
      ) {
        throw new ConflictException(this.i18n.t('auth.ACCOUNT_EXISTS'));
      }

      throw error;
    }

    const token = await this.jwtService.signAsync({
      sub: user.id,
      jti: randomUUID(),
    });

    return {
      user: {
        email: user.email,
        token,
        username: user.username,
        bio: user.bio,
        image: user.image,
      },
    };
  }
}
