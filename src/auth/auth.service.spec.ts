import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { compare, getRounds, hash } from 'bcrypt';
import { I18nService } from 'nestjs-i18n';
import { QueryFailedError } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { LoginDto } from './dto/login.dto';
import { UpdateUserDto } from './dto/update-user.dto';

import { User } from '../database/entities/user.entity';
import { AuthService } from './auth.service';
import {
  BCRYPT_SALT_ROUNDS,
  MYSQL_DUPLICATE_ENTRY_CODE,
} from './constants/auth.constant';

describe('AuthService', () => {
  let service: AuthService;

  const queryBuilder = {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };

  const usersRepository = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    update: jest.fn(),
    findOne: jest.fn(),
    manager: { transaction: jest.fn() },
  };

  const jwtService = {
    signAsync: jest.fn(),
  };

  const i18nService = {
    t: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    queryBuilder.getOne.mockReset();
    usersRepository.update.mockReset().mockResolvedValue({ affected: 1 });
    usersRepository.findOne.mockReset();
    usersRepository.manager.transaction
      .mockReset()
      .mockImplementation(
        async (
          work: (manager: {
            getRepository: () => typeof usersRepository;
          }) => Promise<unknown>,
        ) => work({ getRepository: () => usersRepository }),
      );
    jwtService.signAsync.mockResolvedValue('signed-test-token');
    i18nService.t.mockReturnValue('Invalid email or password');

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getRepositoryToken(User),
          useValue: usersRepository,
        },
        {
          provide: JwtService,
          useValue: jwtService,
        },
        {
          provide: I18nService,
          useValue: i18nService,
        },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  it('returns authenticated user data for valid credentials', async () => {
    const password = 'StrongPass123!';
    const passwordHash = await hash(password, 4);

    const user = {
      id: 'user-uuid',
      tokenVersion: 0,
      email: 'jacob@example.com',
      username: 'jacob',
      passwordHash,
      bio: null,
      image: null,
    };

    queryBuilder.getOne.mockResolvedValue(user);

    const result = await service.login(
      plainToInstance(LoginDto, {
        email: '  JACOB@example.com  ',
        password,
      }),
    );

    expect(result).toEqual({
      user: {
        email: user.email,
        username: user.username,
        token: 'signed-test-token',
        bio: null,
        image: null,
      },
    });

    expect(queryBuilder.where).toHaveBeenCalledWith('user.email = :email', {
      email: 'jacob@example.com',
    });

    expect(jwtService.signAsync).toHaveBeenCalledWith({
      sub: user.id,
      tokenVersion: 0,
      jti: expect.any(String),
    });
  });

  describe('updateUser', () => {
    const user = {
      id: 'user-uuid',
      tokenVersion: 0,
      email: 'jacob@example.com',
      username: 'jacob',
      bio: 'Original bio',
      image: '/existing-avatar.png',
      passwordHash: 'must-not-leak',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      usersRepository.findOne.mockResolvedValue(user);
      i18nService.t.mockReturnValue('Email or username is already in use');
    });

    it('updates normalized fields and atomically rotates the JWT with a hashed password', async () => {
      const password = 'NewStrongPass123!';
      const result = await service.updateUser(
        user.id,
        plainToInstance(UpdateUserDto, {
          username: '  updated_name  ',
          email: '  UPDATED@example.com  ',
          bio: null,
          password,
        }),
        'existing-token',
      );

      expect(usersRepository.update).toHaveBeenCalledWith(user.id, {
        username: 'updated_name',
        email: 'updated@example.com',
        bio: null,
        passwordHash: expect.any(String),
        tokenVersion: expect.any(Function),
      });
      const changes = usersRepository.update.mock.calls[0][1] as {
        passwordHash: string;
        tokenVersion: () => string;
      };
      expect(changes.tokenVersion()).toBe('token_version + 1');
      expect(await compare(password, changes.passwordHash)).toBe(true);
      expect(getRounds(changes.passwordHash)).toBe(BCRYPT_SALT_ROUNDS);
      expect(result).toEqual({
        user: {
          email: user.email,
          username: user.username,
          bio: user.bio,
          image: user.image,
          token: 'signed-test-token',
        },
      });
      expect(usersRepository.manager.transaction).toHaveBeenCalledTimes(1);
      expect(jwtService.signAsync).toHaveBeenCalledWith({
        sub: user.id,
        tokenVersion: user.tokenVersion,
        jti: expect.any(String),
      });
      expect(usersRepository.findOne).toHaveBeenCalledWith({
        where: { id: user.id },
        select: {
          id: true,
          email: true,
          username: true,
          bio: true,
          image: true,
          tokenVersion: true,
        },
      });
    });

    it('propagates signing failure from inside the password transaction', async () => {
      const failure = new Error('Signing unavailable');
      jwtService.signAsync.mockRejectedValueOnce(failure);
      await expect(
        service.updateUser(
          user.id,
          { password: 'NewStrongPass123!' },
          'old-token',
        ),
      ).rejects.toBe(failure);
      const transaction = usersRepository.manager.transaction.mock.results[0]
        .value as Promise<unknown>;
      await expect(transaction).rejects.toBe(failure);
    });

    it.each(['username', 'email', 'bio'] as const)(
      'does not rotate tokens for a %s-only update',
      async (field) => {
        const value = field === 'email' ? 'new@example.test' : 'changed';
        const response = await service.updateUser(
          user.id,
          { [field]: value },
          'existing-token',
        );
        expect(response.user.token).toBe('existing-token');
        expect(usersRepository.update).toHaveBeenCalledWith(user.id, {
          [field]: value,
        });
        expect(usersRepository.manager.transaction).not.toHaveBeenCalled();
        expect(jwtService.signAsync).not.toHaveBeenCalled();
      },
    );

    it('writes only the supplied field and returns the latest stored values', async () => {
      usersRepository.findOne.mockResolvedValue({
        ...user,
        username: 'concurrently_updated',
        bio: 'New bio',
      });

      const result = await service.updateUser(
        user.id,
        { bio: 'New bio' },
        'existing-token',
      );

      expect(usersRepository.update).toHaveBeenCalledWith(user.id, {
        bio: 'New bio',
      });
      expect(result.user.username).toBe('concurrently_updated');
      expect(result.user.bio).toBe('New bio');
    });

    it('treats an empty update as a no-op', async () => {
      await service.updateUser(user.id, {}, 'existing-token');
      expect(usersRepository.update).not.toHaveBeenCalled();
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    });

    it('converts a database duplicate-key race into a translated 409', async () => {
      usersRepository.update.mockRejectedValue(
        new QueryFailedError('UPDATE users', [], {
          name: 'Error',
          message: 'Duplicate entry',
          code: MYSQL_DUPLICATE_ENTRY_CODE,
        }),
      );

      await expect(
        service.updateUser(user.id, { username: 'taken' }, 'existing-token'),
      ).rejects.toThrow(
        new ConflictException('Email or username is already in use'),
      );
      expect(i18nService.t).toHaveBeenCalledWith(
        'auth.ACCOUNT_UPDATE_CONFLICT',
      );
      expect(usersRepository.findOne).not.toHaveBeenCalled();
    });

    it.each([
      new Error('Connection unavailable'),
      new QueryFailedError('UPDATE users', [], {
        name: 'Error',
        message: 'Deadlock',
        code: 'ER_LOCK_DEADLOCK',
      }),
      Object.assign(new Error('Not a TypeORM duplicate error'), {
        code: MYSQL_DUPLICATE_ENTRY_CODE,
      }),
    ])('preserves unexpected errors: %s', async (error) => {
      usersRepository.update.mockRejectedValue(error);
      await expect(
        service.updateUser(user.id, { bio: 'New bio' }, 'existing-token'),
      ).rejects.toBe(error);
      expect(i18nService.t).not.toHaveBeenCalled();
    });

    it('rejects an account removed before the update', async () => {
      usersRepository.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.updateUser(user.id, { bio: 'New bio' }, 'existing-token'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an account removed before the response is read', async () => {
      usersRepository.findOne.mockResolvedValue(null);
      await expect(
        service.updateUser(user.id, {}, 'existing-token'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  it('rejects an unknown email', async () => {
    queryBuilder.getOne.mockResolvedValue(null);

    await expect(
      service.login({
        email: 'missing@example.com',
        password: 'StrongPass123!',
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('rejects an incorrect password', async () => {
    const passwordHash = await hash('CorrectPass123!', 4);

    queryBuilder.getOne.mockResolvedValue({
      id: 'user-uuid',
      tokenVersion: 0,
      email: 'jacob@example.com',
      username: 'jacob',
      passwordHash,
      bio: null,
      image: null,
    });

    await expect(
      service.login({
        email: 'jacob@example.com',
        password: 'WrongPass123!',
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });
});
