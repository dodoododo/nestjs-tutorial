import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { compare } from 'bcrypt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, In, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';

import {
  REDIS_CLIENT,
  REVOCATION_KEY_PREFIX,
} from '../src/redis/redis.constant';
import { RedisService } from '../src/redis/redis.service';

describe('Auth Registration (e2e)', () => {
  let app: INestApplication;
  let usersRepository: Repository<User>;

  const createdEmails: string[] = [];

  const createUser = () => {
    const suffix = randomUUID().slice(0, 8);

    return {
      username: `user_${suffix}`,
      email: `user_${suffix}@example.test`,
      password: 'StrongPass123!',
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    const dataSource = app.get(DataSource);

    // Never write test data to the development database.
    if (
      process.env.NODE_ENV !== 'test' ||
      dataSource.options.type !== 'mysql' ||
      dataSource.options.database !== 'nestjs_tutorial_test' ||
      dataSource.options.port !== 3308
    ) {
      throw new Error('Unsafe test database configuration');
    }

    usersRepository = dataSource.getRepository(User);
  });

  afterEach(async () => {
    if (createdEmails.length > 0) {
      await usersRepository.delete({
        email: In(createdEmails),
      });
      createdEmails.length = 0;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers a user and returns a valid JWT', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    const response = await request(app.getHttpServer())
      .post('/api/users')
      .send({
        user: {
          ...user,
          email: user.email.toUpperCase(),
        },
      })
      .expect(201);

    expect(response.body.user.email).toBe(user.email);
    expect(response.body.user.username).toBe(user.username);
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.user).not.toHaveProperty('password');

    const token: string = response.body.user.token;
    const payload = await app.get(JwtService).verifyAsync<{
      sub: string;
      jti: string;
      exp: number;
    }>(token);

    expect(payload.sub).toBeDefined();
    expect(payload.jti).toBeDefined();
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const storedUser = await usersRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email: user.email })
      .getOneOrFail();

    expect(storedUser.id).toBe(payload.sub);
    expect(storedUser.passwordHash).not.toBe(user.password);
    expect(await compare(user.password, storedUser.passwordHash)).toBe(true);
  });

  it('rejects invalid email', async () => {
    const user = createUser();

    await request(app.getHttpServer())
      .post('/api/users')
      .send({
        user: { ...user, email: 'invalid-email' },
      })
      .expect(400);
  });

  it('rejects passwords exceeding 72 UTF-8 bytes', async () => {
    const user = createUser();

    await request(app.getHttpServer())
      .post('/api/users')
      .send({
        user: { ...user, password: '🔐'.repeat(19) },
      })
      .expect(400);
  });

  it('returns 409 for duplicate email', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/users')
      .send({
        user: { ...user, username: 'another_user' },
      })
      .expect(409);
  });

  it('returns 409 for duplicate username', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/users')
      .send({
        user: {
          ...user,
          email: `other_${randomUUID().slice(0, 8)}@example.test`,
        },
      })
      .expect(409);
  });

  it('logs in successfully and returns a JWT', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/users/login')
      .send({
        user: {
          email: user.email.toUpperCase(),
          password: user.password,
        },
      })
      .expect(200);

    expect(response.body.user.email).toBe(user.email);
    expect(response.body.user.username).toBe(user.username);
    expect(response.body.user.token).toEqual(expect.any(String));

    expect(response.body.user).not.toHaveProperty('password');
    expect(response.body.user).not.toHaveProperty('passwordHash');

    const payload = await app.get(JwtService).verifyAsync<{
      sub: string;
      jti: string;
      exp: number;
    }>(response.body.user.token);

    const storedUser = await usersRepository.findOneByOrFail({
      email: user.email,
    });

    expect(payload.sub).toBe(storedUser.id);
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('returns the same 401 for unknown email and wrong password', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    const incorrectPassword = await request(app.getHttpServer())
      .post('/api/users/login')
      .send({
        user: {
          email: user.email,
          password: 'IncorrectPassword123!',
        },
      })
      .expect(401);

    const unknownEmail = await request(app.getHttpServer())
      .post('/api/users/login')
      .send({
        user: {
          email: `missing_${randomUUID().slice(0, 8)}@example.test`,
          password: 'IncorrectPassword123!',
        },
      })
      .expect(401);

    expect(incorrectPassword.body.message).toBe(unknownEmail.body.message);
  });

  it('rejects invalid login data', async () => {
    await request(app.getHttpServer())
      .post('/api/users/login')
      .send({
        user: {
          email: 'invalid-email',
          password: '',
        },
      })
      .expect(400);
  });

  it('limits repeated login attempts', async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await request(app.getHttpServer())
        .post('/api/users/login')
        .send({
          user: {
            email: 'unknown@example.test',
            password: 'IncorrectPassword123!',
          },
        });

      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
  });

  it('GET /api/users returns the authenticated user', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    const registration = await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    const token: string = registration.body.user.token;

    const response = await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      user: {
        email: user.email,
        username: user.username,
        token,
        bio: null,
        image: null,
      },
    });

    expect(response.body.user).not.toHaveProperty('passwordHash');
  });

  it('GET /api/users rejects a missing token', async () => {
    await request(app.getHttpServer()).get('/api/users').expect(401);
  });

  it('GET /api/users rejects an expired token', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    const storedUser = await usersRepository.findOneByOrFail({
      email: user.email,
    });

    const expiredToken = await app.get(JwtService).signAsync(
      {
        sub: storedUser.id,
        jti: randomUUID(),
      },
      { expiresIn: -1 },
    );

    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401);
  });

  it('GET /api/users rejects tokens for deleted users', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    const registration = await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    const token: string = registration.body.user.token;

    await usersRepository.delete({ email: user.email });

    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('GET /api/users rejects a revoked JWT', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    const registration = await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    const token: string = registration.body.user.token;

    const payload = await app.get(JwtService).verifyAsync<{
      sub: string;
      jti: string;
      exp: number;
    }>(token);

    const redisService = app.get(RedisService);
    const redisClient = app.get<Redis>(REDIS_CLIENT);
    const key = `${REVOCATION_KEY_PREFIX}${payload.jti}`;

    try {
      // Token works before revocation.
      await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await redisService.revokeToken(payload.jti, payload.exp);

      const ttl = await redisClient.ttl(key);
      expect(ttl).toBeGreaterThan(0);

      // The same token must now be rejected.
      await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    } finally {
      // Delete only the revocation created by this test.
      await redisClient.del(key);
    }
  });

  it('GET /api/users fails closed when Redis check fails', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    const registration = await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    const token: string = registration.body.user.token;
    const redisService = app.get(RedisService);

    const checkSpy = jest
      .spyOn(redisService, 'isTokenRevoked')
      .mockRejectedValueOnce(
        new ServiceUnavailableException(
          'Authentication temporarily unavailable',
        ),
      );

    try {
      await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(503);
    } finally {
      checkSpy.mockRestore();
    }
  });

  it('POST /api/logout revokes the JWT immediately', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    const registration = await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    const token: string = registration.body.user.token;

    const payload = await app.get(JwtService).verifyAsync<{
      sub: string;
      jti: string;
      exp: number;
    }>(token);

    const redisClient = app.get<Redis>(REDIS_CLIENT);
    const key = `${REVOCATION_KEY_PREFIX}${payload.jti}`;

    try {
      await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const logoutResponse = await request(app.getHttpServer())
        .post('/api/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      expect(logoutResponse.text).toBe('');

      const ttl = await redisClient.ttl(key);
      expect(ttl).toBeGreaterThan(0);

      await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    } finally {
      await redisClient.del(key);
    }
  });

  it('POST /api/logout rejects missing JWT', async () => {
    await request(app.getHttpServer()).post('/api/logout').expect(401);
  });

  it('POST /api/logout rejects invalid JWT', async () => {
    await request(app.getHttpServer())
      .post('/api/logout')
      .set('Authorization', 'Bearer invalid.jwt.token')
      .expect(401);
  });

  it('POST /api/logout returns 503 when Redis revocation fails', async () => {
    const user = createUser();
    createdEmails.push(user.email);

    const registration = await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);

    const token: string = registration.body.user.token;
    const redisService = app.get(RedisService);

    const revokeSpy = jest
      .spyOn(redisService, 'revokeToken')
      .mockRejectedValueOnce(
        new ServiceUnavailableException(
          'Authentication temporarily unavailable',
        ),
      );

    try {
      await request(app.getHttpServer())
        .post('/api/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(503);
    } finally {
      revokeSpy.mockRestore();
    }

    // Failed revocation must not be reported as success.
    // The token was not added to the blacklist.
    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
