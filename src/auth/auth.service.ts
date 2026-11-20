import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { compare, hash } from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { I18nService } from 'nestjs-i18n';
import { QueryFailedError, Repository } from 'typeorm';

import { User } from '../database/entities/user.entity';
import {
  BCRYPT_SALT_ROUNDS,
  INVALID_USER_PASSWORD_HASH,
  MYSQL_DUPLICATE_ENTRY_CODE,
} from './constants/auth.constant';
import { LoginDto } from './dto/login.dto';
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
        (error.driverError as { code?: string }).code ===
          MYSQL_DUPLICATE_ENTRY_CODE
      ) {
        throw new ConflictException(this.i18n.t('auth.ACCOUNT_EXISTS'));
      }

      throw error;
    }

    return this.createUserResponse(user);
  }

  async login(dto: LoginDto): Promise<UserResponseDto> {
    const email = dto.email.trim().toLowerCase();

    const user = await this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .getOne();

    const passwordHash = user?.passwordHash ?? INVALID_USER_PASSWORD_HASH;

    const isPasswordValid = await compare(dto.password, passwordHash);

    if (!user || !isPasswordValid) {
      throw new UnauthorizedException(this.i18n.t('auth.INVALID_CREDENTIALS'));
    }

    return this.createUserResponse(user);
  }

  getCurrentUser(user: User, token: string): UserResponseDto {
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

  private async createUserResponse(user: User): Promise<UserResponseDto> {
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
