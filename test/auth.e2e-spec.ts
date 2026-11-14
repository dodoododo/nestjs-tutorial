import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { compare } from 'bcrypt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, In, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';

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
});
