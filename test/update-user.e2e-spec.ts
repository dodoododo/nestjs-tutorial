import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { compare, getRounds } from 'bcrypt';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, In, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { BCRYPT_SALT_ROUNDS } from '../src/auth/constants/auth.constant';
import { User } from '../src/database/entities/user.entity';
import {
  REDIS_CLIENT,
  REVOCATION_KEY_PREFIX,
} from '../src/redis/redis.constant';
import { RedisService } from '../src/redis/redis.service';
import { setupSwagger } from '../src/swagger';

describe('Update current user (e2e)', () => {
  let app: INestApplication;
  let usersRepository: Repository<User>;
  let account: Awaited<ReturnType<typeof registerUser>>;
  const createdIds: string[] = [];
  const revocationKeys: string[] = [];

  async function registerUser() {
    const suffix = randomUUID().slice(0, 8);
    const user = {
      username: `update_${suffix}`,
      email: `update_${suffix}@example.test`,
      password: 'StrongPass123!',
    };
    const response = await request(app.getHttpServer())
      .post('/api/users')
      .send({ user })
      .expect(201);
    const token = response.body.user.token as string;
    const payload = await app.get(JwtService).verifyAsync<{
      sub: string;
      jti: string;
      exp: number;
    }>(token);
    createdIds.push(payload.sub);
    return { user, token, ...payload };
  }

  function update(body: object, token = account.token) {
    return request(app.getHttpServer())
      .put('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function storedUser() {
    return usersRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id: account.sub })
      .getOneOrFail();
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
    // Check isolation before creating users or revoking any tokens.
    if (
      process.env.NODE_ENV !== 'test' ||
      dataSource.options.type !== 'mysql' ||
      dataSource.options.host !== '127.0.0.1' ||
      dataSource.options.database !== 'nestjs_tutorial_test' ||
      dataSource.options.port !== 3308 ||
      redisClient.options.host !== '127.0.0.1' ||
      redisClient.options.port !== 6380
    ) {
      throw new Error('Unsafe test database or Redis configuration');
    }
    usersRepository = dataSource.getRepository(User);
  });

  beforeEach(async () => {
    account = await registerUser();
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

  it('updates all permitted fields, retains the JWT, and supports the new credentials', async () => {
    const email = `changed_${randomUUID().slice(0, 8)}@example.test`;
    const username = `changed_${randomUUID().slice(0, 8)}`;
    const password = 'UpdatedStrongPass123!';
    const response = await update({
      user: {
        username: `  ${username}  `,
        email: `  ${email.toUpperCase()}  `,
        bio: 'Updated biography',
        password,
      },
    }).expect(200);

    expect(response.body).toEqual({
      user: {
        email,
        username,
        bio: 'Updated biography',
        image: null,
        token: account.token,
      },
    });
    const stored = await storedUser();
    expect(stored.email).toBe(email);
    expect(stored.username).toBe(username);
    expect(stored.bio).toBe('Updated biography');
    expect(stored.passwordHash).not.toBe(password);
    expect(await compare(password, stored.passwordHash)).toBe(true);
    expect(await compare(account.user.password, stored.passwordHash)).toBe(
      false,
    );
    expect(getRounds(stored.passwordHash)).toBe(BCRYPT_SALT_ROUNDS);

    const current = await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${account.token}`)
      .expect(200);
    expect(current.body).toEqual(response.body);

    await request(app.getHttpServer())
      .post('/api/users/login')
      .send({ user: { email, password: account.user.password } })
      .expect(401);
    const login = await request(app.getHttpServer())
      .post('/api/users/login')
      .send({ user: { email, password } })
      .expect(200);
    expect(login.body.user.email).toBe(email);
  });

  it('preserves omitted values, the password hash, and the existing avatar', async () => {
    await usersRepository.update(account.sub, {
      image: '/existing-avatar.png',
    });
    const before = await storedUser();
    const response = await update({
      user: { bio: 'Only the bio changes' },
    }).expect(200);
    const after = await storedUser();
    expect(after.username).toBe(before.username);
    expect(after.email).toBe(before.email);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(response.body).toEqual({
      user: {
        email: before.email,
        username: before.username,
        bio: 'Only the bio changes',
        image: before.image,
        token: account.token,
      },
    });
  });

  it('allows clearing the bio with null or setting empty text', async () => {
    await update({ user: { bio: 'Original bio' } }).expect(200);
    const cleared = await update({ user: { bio: null } }).expect(200);
    expect(cleared.body.user.bio).toBeNull();
    expect((await storedUser()).bio).toBeNull();
    const empty = await update({ user: { bio: '' } }).expect(200);
    expect(empty.body.user.bio).toBe('');
    expect((await storedUser()).bio).toBe('');
  });

  it('accepts unchanged unique fields and an empty user object', async () => {
    await update({
      user: { username: account.user.username, email: account.user.email },
    }).expect(200);
    const before = await storedUser();
    await update({ user: {} }).expect(200);
    expect(await storedUser()).toEqual(before);
  });

  it('updates only the token owner and leaves another account unchanged', async () => {
    const other = await registerUser();
    const before = await usersRepository.findOneByOrFail({ id: other.sub });
    await update({ user: { bio: 'Owner bio' } }).expect(200);
    expect(await usersRepository.findOneByOrFail({ id: other.sub })).toEqual(
      before,
    );
    expect((await storedUser()).bio).toBe('Owner bio');
  });

  it.each(['id', 'userId', 'passwordHash', 'image', 'createdAt', 'updatedAt'])(
    'rejects the unexpected nested field %s without modifying either account',
    async (field) => {
      const other = await registerUser();
      const before = await storedUser();
      const otherBefore = await usersRepository.findOneByOrFail({
        id: other.sub,
      });
      await update({
        user: { [field]: other.sub, bio: 'Must not be saved' },
      }).expect(400);
      expect(await storedUser()).toEqual(before);
      expect(await usersRepository.findOneByOrFail({ id: other.sub })).toEqual(
        otherBefore,
      );
    },
  );

  it('rejects an account ID at the top level', async () => {
    const before = await storedUser();
    await update({
      id: randomUUID(),
      user: { bio: 'Must not be saved' },
    }).expect(400);
    expect(await storedUser()).toEqual(before);
  });

  it.each(['username', 'email'] as const)(
    'returns a translated 409 for duplicate %s and keeps the update atomic',
    async (field) => {
      const other = await registerUser();
      const before = await storedUser();
      const response = await request(app.getHttpServer())
        .put('/api/users?lang=vi')
        .set('Authorization', `Bearer ${account.token}`)
        .send({
          user: { [field]: other.user[field], bio: 'Must not be saved' },
        })
        .expect(409);
      expect(response.body.message).toBe(
        'Email hoặc tên người dùng đã được sử dụng',
      );
      expect(await storedUser()).toEqual(before);
    },
  );

  it.each([
    ['whitespace-only username', { username: '   \t\n' }],
    ['short trimmed username', { username: '  ab  ' }],
    ['long username', { username: 'a'.repeat(51) }],
    ['null username', { username: null }],
    ['invalid email', { email: 'invalid-email' }],
    ['long email', { email: `${'a'.repeat(250)}@example.test` }],
    ['null email', { email: null }],
    ['short password', { password: 'short' }],
    ['long password', { password: 'a'.repeat(73) }],
    ['multibyte password exceeding 72 bytes', { password: '🔐'.repeat(19) }],
    ['null password', { password: null }],
    ['non-string password', { password: 12345678 }],
    ['non-string bio', { bio: 123 }],
  ])('rejects %s without saving any supplied fields', async (_name, fields) => {
    const before = await storedUser();
    await update({ user: { username: 'valid_username', ...fields } }).expect(
      400,
    );
    expect(await storedUser()).toEqual(before);
  });

  it.each([{}, { user: null }, { user: [] }, { user: 'invalid' }])(
    'rejects an invalid request envelope: %j',
    async (body) => {
      await update(body).expect(400);
    },
  );

  it('rejects a missing JWT', async () => {
    await request(app.getHttpServer())
      .put('/api/users')
      .send({ user: { bio: 'Must not be saved' } })
      .expect(401);
  });

  it('rejects an invalid JWT', async () => {
    await update(
      { user: { bio: 'Must not be saved' } },
      'invalid.jwt.token',
    ).expect(401);
    expect((await storedUser()).bio).toBeNull();
  });

  it('rejects an expired JWT', async () => {
    const expired = await app
      .get(JwtService)
      .signAsync({ sub: account.sub, jti: randomUUID() }, { expiresIn: -1 });
    await update({ user: { bio: 'Must not be saved' } }, expired).expect(401);
    expect((await storedUser()).bio).toBeNull();
  });

  it('rejects a JWT revoked through the existing logout endpoint', async () => {
    revocationKeys.push(`${REVOCATION_KEY_PREFIX}${account.jti}`);
    await request(app.getHttpServer())
      .post('/api/logout')
      .set('Authorization', `Bearer ${account.token}`)
      .expect(204);
    await update({ user: { bio: 'Must not be saved' } }).expect(401);
    expect((await storedUser()).bio).toBeNull();
  });

  it('rejects a JWT belonging to a deleted account', async () => {
    await usersRepository.delete(account.sub);
    await update({ user: { bio: 'Must not be saved' } }).expect(401);
    expect(await usersRepository.findOneBy({ id: account.sub })).toBeNull();
  });

  it('fails closed if the Redis revocation check fails', async () => {
    jest
      .spyOn(app.get(RedisService), 'isTokenRevoked')
      .mockRejectedValueOnce(new ServiceUnavailableException());
    await update({ user: { bio: 'Must not be saved' } }).expect(503);
    expect((await storedUser()).bio).toBeNull();
  });

  it('documents the protected PUT route and preserves the GET route', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const paths = response.body.paths['/api/users'];
    expect(paths.get).toBeDefined();
    expect(paths.put.security).toEqual([{ bearer: [] }]);
    expect(paths.put.responses).toHaveProperty('200');
    expect(paths.put.responses).toHaveProperty('400');
    expect(paths.put.responses).toHaveProperty('401');
    expect(paths.put.responses).toHaveProperty('409');
  });
});
