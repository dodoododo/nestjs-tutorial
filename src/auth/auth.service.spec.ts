import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { hash } from 'bcrypt';
import { I18nService } from 'nestjs-i18n';

import { User } from '../database/entities/user.entity';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;

  const queryBuilder = {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };

  const usersRepository = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
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
      email: 'jacob@example.com',
      username: 'jacob',
      passwordHash,
      bio: null,
      image: null,
    };

    queryBuilder.getOne.mockResolvedValue(user);

    const result = await service.login({
      email: 'JACOB@example.com',
      password,
    });

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
      jti: expect.any(String),
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
