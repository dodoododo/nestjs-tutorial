import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, In, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { INVALID_USER_PASSWORD_HASH } from '../src/auth/constants/auth.constant';
import { Follow } from '../src/database/entities/follow.entity';
import { User } from '../src/database/entities/user.entity';
import {
  REDIS_CLIENT,
  REVOCATION_KEY_PREFIX,
} from '../src/redis/redis.constant';
import { RedisService } from '../src/redis/redis.service';
import { setupSwagger } from '../src/swagger';

type Method = 'get' | 'post' | 'delete';

describe('Profile and follow APIs (e2e)', () => {
  let app: INestApplication;
  let usersRepository: Repository<User>;
  let followsRepository: Repository<Follow>;
  let actor: User;
  let target: User;
  let other: User;
  let token: string;
  const createdIds: string[] = [];
  const revocationKeys: string[] = [];

  function profileRequest(
    method: Method,
    username = target.username,
    authorization?: string,
  ) {
    const suffix = method === 'get' ? '' : '/follow';
    const req = request(app.getHttpServer())[method](
      `/api/profiles/${encodeURIComponent(username)}${suffix}`,
    );
    if (authorization !== undefined) {
      req.set('Authorization', authorization);
    }
    return req;
  }

  function expectedProfile(following: boolean) {
    return {
      profile: {
        username: target.username,
        bio: target.bio,
        image: target.image,
        following,
      },
    };
  }

  async function revokeCurrentToken() {
    const payload = await app
      .get(JwtService)
      .verifyAsync<{ jti: string }>(token);
    revocationKeys.push(`${REVOCATION_KEY_PREFIX}${payload.jti}`);
    await request(app.getHttpServer())
      .post('/api/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    setupSwagger(app);
    await app.init();

    const dataSource = app.get(DataSource);
    const redisClient = app.get<Redis>(REDIS_CLIENT);
    if (
      process.env.NODE_ENV !== 'test' ||
      dataSource.options.type !== 'mysql' ||
      dataSource.options.host !== '127.0.0.1' ||
      dataSource.options.port !== 3308 ||
      dataSource.options.database !== 'nestjs_tutorial_test' ||
      dataSource.options.synchronize !== false ||
      redisClient.options.host !== '127.0.0.1' ||
      redisClient.options.port !== 6380
    ) {
      throw new Error('Unsafe test database or Redis configuration');
    }
    usersRepository = dataSource.getRepository(User);
    followsRepository = dataSource.getRepository(Follow);
  });

  beforeEach(async () => {
    const users = Array.from({ length: 3 }, () => {
      const id = randomUUID();
      createdIds.push(id);
      return usersRepository.create({
        id,
        username: `profile_${id}`,
        email: `profile_${id}@example.test`,
        passwordHash: INVALID_USER_PASSWORD_HASH,
        bio: 'Public biography',
        image: '/existing-avatar.png',
      });
    });
    [actor, target, other] = await usersRepository.save(users);
    token = await app.get(JwtService).signAsync({
      sub: actor.id,
      jti: randomUUID(),
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (createdIds.length > 0) {
      await usersRepository.delete({ id: In(createdIds) });
      createdIds.length = 0;
    }
    if (revocationKeys.length > 0) {
      await app.get<Redis>(REDIS_CLIENT).del(...revocationKeys);
      revocationKeys.length = 0;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns only public profile fields anonymously even when follows exist', async () => {
    await followsRepository.insert({
      followerId: actor.id,
      followingId: target.id,
    });
    const response = await profileRequest('get').expect(200);
    expect(response.body).toEqual(expectedProfile(false));
  });

  it('returns nullable bio and image fields', async () => {
    await usersRepository.update(target.id, { bio: null, image: null });
    const response = await profileRequest('get').expect(200);
    expect(response.body).toEqual({
      profile: {
        username: target.username,
        bio: null,
        image: null,
        following: false,
      },
    });
  });

  it('returns following: true only for the authenticated user relationship', async () => {
    await followsRepository.insert({
      followerId: actor.id,
      followingId: target.id,
    });
    const response = await profileRequest(
      'get',
      target.username,
      `Bearer ${token}`,
    ).expect(200);
    expect(response.body).toEqual(expectedProfile(true));

    const otherToken = await app.get(JwtService).signAsync({
      sub: other.id,
      jti: randomUUID(),
    });
    const otherResponse = await profileRequest(
      'get',
      target.username,
      `Bearer ${otherToken}`,
    ).expect(200);
    expect(otherResponse.body).toEqual(expectedProfile(false));
  });

  it('returns following: false when only the reverse relationship exists', async () => {
    await followsRepository.insert({
      followerId: target.id,
      followingId: actor.id,
    });
    const response = await profileRequest(
      'get',
      target.username,
      `Bearer ${token}`,
    ).expect(200);
    expect(response.body).toEqual(expectedProfile(false));
  });

  it.each(['', 'Bearer', 'Basic credentials', 'Bearer invalid.jwt.token'])(
    'rejects supplied invalid or malformed profile credentials: %j',
    async (authorization) => {
      await profileRequest('get', target.username, authorization).expect(401);
    },
  );

  it('rejects an expired JWT on the public profile route', async () => {
    const expired = await app
      .get(JwtService)
      .signAsync({ sub: actor.id, jti: randomUUID() }, { expiresIn: -1 });
    await profileRequest('get', target.username, `Bearer ${expired}`).expect(
      401,
    );
  });

  it('rejects an incorrectly signed JWT on the public profile route', async () => {
    const invalid = await app
      .get(JwtService)
      .signAsync(
        { sub: actor.id, jti: randomUUID() },
        { secret: 'different-secret-with-at-least-32-bytes' },
      );
    await profileRequest('get', target.username, `Bearer ${invalid}`).expect(
      401,
    );
  });

  it('rejects a signed JWT with a malformed payload', async () => {
    const invalid = await app.get(JwtService).signAsync({ sub: actor.id });
    await profileRequest('get', target.username, `Bearer ${invalid}`).expect(
      401,
    );
  });

  it('rejects a supplied JWT for a deleted account', async () => {
    await usersRepository.delete(actor.id);
    await profileRequest('get', target.username, `Bearer ${token}`).expect(401);
  });

  it.each(['get', 'post', 'delete'] as const)(
    '%s rejects a JWT revoked through the existing logout endpoint',
    async (method) => {
      await revokeCurrentToken();
      await profileRequest(method, target.username, `Bearer ${token}`).expect(
        401,
      );
      expect(await followsRepository.countBy({ followerId: actor.id })).toBe(0);
    },
  );

  it.each(['get', 'post', 'delete'] as const)(
    '%s fails closed if the Redis revocation check fails',
    async (method) => {
      jest
        .spyOn(app.get(RedisService), 'isTokenRevoked')
        .mockRejectedValueOnce(
          new ServiceUnavailableException(
            'Authentication temporarily unavailable',
          ),
        );
      await profileRequest(method, target.username, `Bearer ${token}`).expect(
        503,
      );
      expect(await followsRepository.countBy({ followerId: actor.id })).toBe(0);
    },
  );

  it('serves anonymous profiles without a Redis authentication check', async () => {
    const check = jest
      .spyOn(app.get(RedisService), 'isTokenRevoked')
      .mockRejectedValue(new ServiceUnavailableException());
    const response = await profileRequest('get').expect(200);
    expect(response.body).toEqual(expectedProfile(false));
    expect(check).not.toHaveBeenCalled();
  });

  it.each(['get', 'post', 'delete'] as const)(
    '%s returns 404 for a nonexistent profile',
    async (method) => {
      const response = await profileRequest(
        method,
        `missing_${randomUUID()}`,
        method === 'get' ? undefined : `Bearer ${token}`,
      ).expect(404);
      expect(response.body.message).toBe('Profile not found');
    },
  );

  it.each(['post', 'delete'] as const)(
    '%s rejects a missing JWT',
    async (method) => {
      await profileRequest(method).expect(401);
    },
  );

  it.each(['post', 'delete'] as const)(
    '%s rejects an invalid JWT',
    async (method) => {
      await profileRequest(
        method,
        target.username,
        'Bearer invalid.jwt.token',
      ).expect(401);
      expect(await followsRepository.countBy({ followerId: actor.id })).toBe(0);
    },
  );

  it('follows the target and makes the relationship visible on GET', async () => {
    const response = await profileRequest(
      'post',
      target.username,
      `Bearer ${token}`,
    ).expect(200);
    expect(response.body).toEqual(expectedProfile(true));
    expect(
      await followsRepository.countBy({
        followerId: actor.id,
        followingId: target.id,
      }),
    ).toBe(1);
    const profile = await profileRequest(
      'get',
      target.username,
      `Bearer ${token}`,
    ).expect(200);
    expect(profile.body).toEqual(expectedProfile(true));
  });

  it('returns a translated 409 for duplicate follows', async () => {
    await followsRepository.insert({
      followerId: actor.id,
      followingId: target.id,
    });
    const response = await request(app.getHttpServer())
      .post(`/api/profiles/${target.username}/follow?lang=vi`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(response.body.message).toBe('Bạn đã theo dõi người dùng này');
    expect(
      await followsRepository.countBy({
        followerId: actor.id,
        followingId: target.id,
      }),
    ).toBe(1);
  });

  it('returns 200 and 409 for concurrent duplicate follows, never 500', async () => {
    const responses = await Promise.all([
      profileRequest('post', target.username, `Bearer ${token}`),
      profileRequest('post', target.username, `Bearer ${token}`),
    ]);
    expect(
      responses
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 200)!.body).toEqual(
      expectedProfile(true),
    );
    expect(
      await followsRepository.countBy({
        followerId: actor.id,
        followingId: target.id,
      }),
    ).toBe(1);
  });

  it('rejects self-follow even with a different username casing', async () => {
    for (const username of [actor.username, actor.username.toUpperCase()]) {
      const response = await profileRequest(
        'post',
        username,
        `Bearer ${token}`,
      ).expect(400);
      expect(response.body.message).toBe('You cannot follow yourself');
    }
    expect(await followsRepository.countBy({ followerId: actor.id })).toBe(0);
  });

  it('ignores client-supplied identity fields when following', async () => {
    const response = await profileRequest(
      'post',
      target.username,
      `Bearer ${token}`,
    )
      .send({
        followerId: other.id,
        followingId: other.id,
        user: { id: other.id },
      })
      .expect(200);
    expect(response.body).toEqual(expectedProfile(true));
    expect(
      await followsRepository.countBy({
        followerId: actor.id,
        followingId: target.id,
      }),
    ).toBe(1);
    expect(await followsRepository.countBy({ followerId: other.id })).toBe(0);
    expect(await followsRepository.countBy({ followingId: other.id })).toBe(0);
  });

  it('unfollows and returns the same response on repeated requests', async () => {
    await followsRepository.insert({
      followerId: actor.id,
      followingId: target.id,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await profileRequest(
        'delete',
        target.username,
        `Bearer ${token}`,
      ).expect(200);
      expect(response.body).toEqual(expectedProfile(false));
    }
    expect(
      await followsRepository.countBy({
        followerId: actor.id,
        followingId: target.id,
      }),
    ).toBe(0);
    const profile = await profileRequest(
      'get',
      target.username,
      `Bearer ${token}`,
    ).expect(200);
    expect(profile.body).toEqual(expectedProfile(false));
    expect(await usersRepository.countBy({ id: In(createdIds) })).toBe(3);
  });

  it('cannot remove another user relationship or unrelated current-user relationships', async () => {
    await followsRepository.insert([
      { followerId: actor.id, followingId: target.id },
      { followerId: other.id, followingId: target.id },
      { followerId: actor.id, followingId: other.id },
      { followerId: target.id, followingId: actor.id },
    ]);
    await profileRequest('delete', target.username, `Bearer ${token}`)
      .send({ followerId: other.id, followingId: other.id, userId: other.id })
      .expect(200);
    expect(
      await followsRepository.countBy({
        followerId: actor.id,
        followingId: target.id,
      }),
    ).toBe(0);
    for (const pair of [
      { followerId: other.id, followingId: target.id },
      { followerId: actor.id, followingId: other.id },
      { followerId: target.id, followingId: actor.id },
    ]) {
      expect(await followsRepository.countBy(pair)).toBe(1);
    }
  });

  it('translates not-found and self-follow errors into Vietnamese', async () => {
    const missing = await request(app.getHttpServer())
      .get(`/api/profiles/missing_${randomUUID()}?lang=vi`)
      .expect(404);
    expect(missing.body.message).toBe('Không tìm thấy hồ sơ người dùng');
    const self = await request(app.getHttpServer())
      .post(`/api/profiles/${actor.username}/follow?lang=vi`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(self.body.message).toBe('Bạn không thể theo dõi chính mình');
  });

  it('documents optional authentication and the protected follow/unfollow routes', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const paths = response.body.paths;
    expect(paths['/api/profiles/{username}'].get.security).toEqual([
      {},
      { bearer: [] },
    ]);
    const follow = paths['/api/profiles/{username}/follow'];
    expect(follow.post.security).toEqual([{ bearer: [] }]);
    expect(follow.delete.security).toEqual([{ bearer: [] }]);
    for (const status of ['200', '400', '401', '404', '409', '503']) {
      expect(follow.post.responses).toHaveProperty(status);
    }
    const profile = response.body.components.schemas.ProfileDto;
    expect(Object.keys(profile.properties).sort()).toEqual([
      'bio',
      'following',
      'image',
      'username',
    ]);
  });
});
