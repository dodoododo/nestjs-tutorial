import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { I18nService } from 'nestjs-i18n';
import { QueryFailedError } from 'typeorm';

import { Follow } from '../database/entities/follow.entity';
import { User } from '../database/entities/user.entity';
import { ProfilesService } from './profiles.service';

describe('ProfilesService', () => {
  let service: ProfilesService;
  const usersRepository = { findOne: jest.fn() };
  const followsRepository = {
    existsBy: jest.fn(),
    insert: jest.fn(),
    delete: jest.fn(),
  };
  const messages: Record<string, string> = {
    'profiles.NOT_FOUND': 'Profile not found',
    'profiles.SELF_FOLLOW': 'You cannot follow yourself',
  };
  const i18n = { t: jest.fn((key: string) => messages[key]) };
  const target = {
    id: 'target-id',
    username: 'target',
    bio: 'Public biography',
    image: '/avatar.png',
    email: 'private@example.test',
    passwordHash: 'private-hash',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const publicProfile = {
    username: target.username,
    bio: target.bio,
    image: target.image,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    usersRepository.findOne.mockReset().mockResolvedValue(target);
    followsRepository.existsBy.mockReset().mockResolvedValue(false);
    followsRepository.insert.mockReset().mockResolvedValue({});
    followsRepository.delete.mockReset().mockResolvedValue({ affected: 1 });

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProfilesService,
        { provide: getRepositoryToken(User), useValue: usersRepository },
        { provide: getRepositoryToken(Follow), useValue: followsRepository },
        { provide: I18nService, useValue: i18n },
      ],
    }).compile();
    service = moduleRef.get(ProfilesService);
  });

  it('returns only public fields anonymously without querying relationships', async () => {
    expect(await service.getProfile(target.username)).toEqual({
      profile: { ...publicProfile, following: false },
    });
    expect(usersRepository.findOne).toHaveBeenCalledWith({
      where: { username: target.username },
      select: { id: true, username: true, bio: true, image: true },
    });
    expect(followsRepository.existsBy).not.toHaveBeenCalled();
  });

  it.each(['getProfile', 'follow', 'unfollow'] as const)(
    'preserves nullable public fields through %s',
    async (method) => {
      usersRepository.findOne.mockResolvedValue({
        ...target,
        bio: null,
        image: null,
        role: 'private-role',
        token: 'private-token',
      });
      expect(await service[method](target.username, 'current-user')).toEqual({
        profile: {
          username: target.username,
          bio: null,
          image: null,
          following: method === 'follow',
        },
      });
    },
  );

  it.each([true, false])(
    'returns following: %s for the current user relationship',
    async (following) => {
      followsRepository.existsBy.mockResolvedValue(following);
      expect(await service.getProfile(target.username, 'current-user')).toEqual(
        {
          profile: { ...publicProfile, following },
        },
      );
      expect(followsRepository.existsBy).toHaveBeenCalledWith({
        followerId: 'current-user',
        followingId: target.id,
      });
    },
  );

  it.each(['getProfile', 'follow', 'unfollow'] as const)(
    '%s returns a translated 404 when the target does not exist',
    async (method) => {
      usersRepository.findOne.mockResolvedValue(null);
      await expect(service[method]('missing', 'current-user')).rejects.toThrow(
        new NotFoundException('Profile not found'),
      );
      expect(followsRepository.existsBy).not.toHaveBeenCalled();
      expect(followsRepository.insert).not.toHaveBeenCalled();
      expect(followsRepository.delete).not.toHaveBeenCalled();
    },
  );

  it('inserts a directed follow and returns only public fields', async () => {
    expect(await service.follow(target.username, 'current-user')).toEqual({
      profile: { ...publicProfile, following: true },
    });
    expect(followsRepository.insert).toHaveBeenCalledWith({
      followerId: 'current-user',
      followingId: target.id,
    });
    expect(followsRepository.existsBy).not.toHaveBeenCalled();
  });

  it('rejects self-follow based on the resolved user ID', async () => {
    await expect(service.follow('TARGET', target.id)).rejects.toThrow(
      new BadRequestException('You cannot follow yourself'),
    );
    expect(followsRepository.insert).not.toHaveBeenCalled();
  });

  it('returns success for an expected duplicate pair, including races', async () => {
    followsRepository.insert.mockRejectedValue(
      new QueryFailedError(
        'INSERT INTO follows',
        [],
        Object.assign(
          new Error(
            "Duplicate entry for key 'follows.IDX_follows_follower_following_unique'",
          ),
          { code: 'ER_DUP_ENTRY' },
        ),
      ),
    );
    await expect(
      service.follow(target.username, 'current-user'),
    ).resolves.toEqual({ profile: { ...publicProfile, following: true } });
    expect(followsRepository.existsBy).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Database unavailable'),
    new QueryFailedError(
      'INSERT INTO follows',
      [],
      Object.assign(new Error("Duplicate entry for key 'PRIMARY'"), {
        code: 'ER_DUP_ENTRY',
      }),
    ),
    new QueryFailedError(
      'INSERT INTO follows',
      [],
      Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }),
    ),
    new QueryFailedError(
      'INSERT INTO follows',
      [],
      Object.assign(new Error('Foreign key violation'), {
        code: 'ER_NO_REFERENCED_ROW_2',
      }),
    ),
    Object.assign(new Error('Not a TypeORM duplicate error'), {
      code: 'ER_DUP_ENTRY',
    }),
  ])('preserves unexpected follow errors: %s', async (error) => {
    followsRepository.insert.mockRejectedValue(error);
    await expect(service.follow(target.username, 'current-user')).rejects.toBe(
      error,
    );
  });

  it.each([0, 1])(
    'unfollows only the current user relationship and returns false with %s deletions',
    async (affected) => {
      followsRepository.delete.mockResolvedValue({ affected });
      expect(await service.unfollow(target.username, 'current-user')).toEqual({
        profile: { ...publicProfile, following: false },
      });
      expect(followsRepository.delete).toHaveBeenCalledWith({
        followerId: 'current-user',
        followingId: target.id,
      });
      expect(followsRepository.existsBy).not.toHaveBeenCalled();
    },
  );

  it('preserves unexpected unfollow errors', async () => {
    const error = new Error('Database unavailable');
    followsRepository.delete.mockRejectedValue(error);
    await expect(
      service.unfollow(target.username, 'current-user'),
    ).rejects.toBe(error);
  });
});
