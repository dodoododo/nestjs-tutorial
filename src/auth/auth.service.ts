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
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';

@Injectable()
// HTTP callers supply DTO-transformed, validated input; direct callers must do the same.
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
      username: dto.username,
      email: dto.email,
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
    const user = await this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email: dto.email })
      .getOne();

    const passwordHash = user?.passwordHash ?? INVALID_USER_PASSWORD_HASH;

    const isPasswordValid = await compare(dto.password, passwordHash);

    if (!user || !isPasswordValid) {
      throw new UnauthorizedException(this.i18n.t('auth.INVALID_CREDENTIALS'));
    }

    return this.createUserResponse(user);
  }

  async updateUser(
    userId: string,
    dto: UpdateUserDto,
    token: string,
  ): Promise<UserResponseDto> {
    const changes: Partial<
      Pick<User, 'username' | 'email' | 'bio' | 'passwordHash'>
    > = {};

    if (dto.username !== undefined) {
      changes.username = dto.username;
    }
    if (dto.email !== undefined) {
      changes.email = dto.email;
    }
    if (dto.bio !== undefined) {
      changes.bio = dto.bio;
    }
    if (dto.password !== undefined) {
      changes.passwordHash = await hash(dto.password, BCRYPT_SALT_ROUNDS);
    }

    const persist = async (
      repository: Repository<User>,
    ): Promise<UserResponseDto> => {
      if (Object.keys(changes).length > 0) {
        // One UPDATE changes the hash and increments the version under the same row lock.
        const result = await repository.update(userId, {
          ...changes,
          ...(dto.password !== undefined
            ? { tokenVersion: () => 'token_version + 1' }
            : {}),
        });
        if (result.affected === 0) {
          throw new UnauthorizedException();
        }
      }

      const user = await repository.findOne({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          username: true,
          bio: true,
          image: true,
          tokenVersion: true,
        },
      });
      if (!user) {
        throw new UnauthorizedException();
      }

      return dto.password !== undefined
        ? this.createUserResponse(user)
        : this.getCurrentUser(user, token);
    };

    try {
      // Keep the row lock through reading/signing: a concurrent password change
      // must never lend its newer version to this request's JWT. Signing failure rolls back.
      return await (dto.password !== undefined
        ? this.usersRepository.manager.transaction((manager) =>
            persist(manager.getRepository(User)),
          )
        : persist(this.usersRepository));
    } catch (error: unknown) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code ===
          MYSQL_DUPLICATE_ENTRY_CODE
      ) {
        throw new ConflictException(
          this.i18n.t('auth.ACCOUNT_UPDATE_CONFLICT'),
        );
      }
      throw error;
    }
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
      tokenVersion: user.tokenVersion,
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
