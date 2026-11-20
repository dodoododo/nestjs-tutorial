import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { INVALID_USER_PASSWORD_HASH } from '../src/auth/constants/auth.constant';
import { setupAvatarStaticAssets } from '../src/avatars/avatar-static';
import { AvatarStorageService } from '../src/avatars/avatar-storage.service';
import {
  AVATAR_FILE_NAME_PATTERN,
  AVATAR_FORMATS,
  AVATAR_MAX_BYTES,
  type AvatarFormat,
} from '../src/avatars/avatar.constants';
import { Attachment } from '../src/database/entities/attachment.entity';
import { User } from '../src/database/entities/user.entity';
import {
  REDIS_CLIENT,
  REVOCATION_KEY_PREFIX,
} from '../src/redis/redis.constant';
import { RedisService } from '../src/redis/redis.service';
import { setupSwagger } from '../src/swagger';
import { avatarBuffer } from './helpers/avatar-fixtures';

describe('Public avatar upload (e2e)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let users: Repository<User>;
  let attachments: Repository<Attachment>;
  let storage: AvatarStorageService;
  let root: string;
  let directory: string;
  let owner: User;
  let other: User;
  let token: string;
  let buffers: Record<AvatarFormat, Buffer>;
  const userIds: string[] = [];
  const extraAttachmentIds: string[] = [];
  const revocationKeys: string[] = [];

  function upload(
    format: AvatarFormat = 'png',
    authorization: string | null = `Bearer ${token}`,
  ) {
    const req = request(app.getHttpServer()).put('/api/users/avatar');
    if (authorization !== null) req.set('Authorization', authorization);
    return req.attach('avatar', buffers[format], {
      filename: '../../client-controlled.html',
      contentType: AVATAR_FORMATS[format].mime,
    });
  }

  async function ownerAttachments() {
    return attachments.findBy({
      attachableType: 'user',
      attachableId: owner.id,
    });
  }

  async function generatedFiles() {
    return (await readdir(directory))
      .filter((name) => AVATAR_FILE_NAME_PATTERN.test(name))
      .sort();
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nestjs-avatar-e2e-'));
    directory = join(root, 'avatars');
    storage = new AvatarStorageService(
      new ConfigService({ AVATAR_STORAGE_DIR: directory }),
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AvatarStorageService)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');
    await setupAvatarStaticAssets(app);
    setupSwagger(app);
    await app.init();
    dataSource = app.get(DataSource);
    const redis = app.get<Redis>(REDIS_CLIENT);
    if (
      process.env.NODE_ENV !== 'test' ||
      dataSource.options.type !== 'mysql' ||
      dataSource.options.host !== '127.0.0.1' ||
      dataSource.options.port !== 3308 ||
      dataSource.options.database !== 'nestjs_tutorial_test' ||
      dataSource.options.synchronize !== false ||
      redis.options.host !== '127.0.0.1' ||
      redis.options.port !== 6380 ||
      app.get(AvatarStorageService).directory !== directory
    )
      throw new Error('Unsafe test database, Redis or avatar directory');
    users = dataSource.getRepository(User);
    attachments = dataSource.getRepository(Attachment);
    buffers = {
      jpeg: await avatarBuffer('jpeg'),
      png: await avatarBuffer('png'),
      webp: await avatarBuffer('webp'),
    };
    await writeFile(join(root, 'outside-secret.txt'), 'outside-secret');
    await writeFile(join(directory, 'unrelated.html'), 'unrelated-file');
  });

  beforeEach(async () => {
    const fixtures = Array.from({ length: 2 }, () => {
      const id = randomUUID();
      userIds.push(id);
      return users.create({
        id,
        username: `avatar_${id}`,
        email: `avatar_${id}@example.test`,
        passwordHash: INVALID_USER_PASSWORD_HASH,
        bio: 'Public bio',
        image: '/preexisting-external.png',
      });
    });
    [owner, other] = await users.save(fixtures);
    token = await app
      .get(JwtService)
      .signAsync({ sub: owner.id, jti: randomUUID() });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (userIds.length) {
      await attachments.delete({
        attachableType: 'user',
        attachableId: In(userIds),
      });
      await users.delete({ id: In(userIds) });
      userIds.length = 0;
    }
    if (extraAttachmentIds.length) {
      await attachments.delete({ id: In(extraAttachmentIds) });
      extraAttachmentIds.length = 0;
    }
    if (revocationKeys.length) {
      await app.get<Redis>(REDIS_CLIENT).del(...revocationKeys);
      revocationKeys.length = 0;
    }
    // This newly created directory belongs exclusively to this suite. Remove
    // only generated avatar basenames; sentinel files must survive every test.
    for (const file of await generatedFiles())
      await unlink(join(directory, file));
    expect(await readFile(join(directory, 'unrelated.html'), 'utf8')).toBe(
      'unrelated-file',
    );
    expect(await readFile(join(root, 'outside-secret.txt'), 'utf8')).toBe(
      'outside-secret',
    );
  });

  afterAll(async () => {
    await app?.close();
    if (directory) {
      await unlink(join(directory, 'unrelated.html'));
      await rmdir(directory);
      await unlink(join(root, 'outside-secret.txt'));
      await rmdir(root);
    }
  });

  it.each(['jpeg', 'png', 'webp'] as const)(
    'uploads and publicly serves a validated %s with matching metadata',
    async (format) => {
      const response = await upload(format).expect(200);
      const image = response.body.user.image as string;
      expect(response.body).toEqual({
        user: {
          email: owner.email,
          username: owner.username,
          bio: owner.bio,
          image,
          token,
        },
      });
      const metadata = await ownerAttachments();
      expect(metadata).toHaveLength(1);
      const record = metadata[0];
      expect(record.fileName).toMatch(AVATAR_FILE_NAME_PATTERN);
      expect(
        record.fileName.endsWith(`.${AVATAR_FORMATS[format].extension}`),
      ).toBe(true);
      expect(record.url).toBe(image);
      expect(record.fileType).toBe(AVATAR_FORMATS[format].mime);
      const stored = await readFile(join(directory, record.fileName));
      expect(record.fileSize).toBe(String(stored.length));
      expect((await sharp(stored).metadata()).format).toBe(format);
      expect((await users.findOneByOrFail({ id: owner.id })).image).toBe(image);
      expect((await users.findOneByOrFail({ id: other.id })).image).toBe(
        other.image,
      );
      const publicFile = await request(app.getHttpServer())
        .get(image)
        .expect(200);
      expect(publicFile.headers['content-type']).toBe(
        AVATAR_FORMATS[format].mime,
      );
      expect(publicFile.headers['x-content-type-options']).toBe('nosniff');
      expect(publicFile.body).toEqual(stored);
      const current = await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(current.body).toEqual(response.body);
      const profile = await request(app.getHttpServer())
        .get(`/api/profiles/${owner.username}`)
        .expect(200);
      expect(profile.body).toEqual({
        profile: {
          username: owner.username,
          bio: owner.bio,
          image,
          following: false,
        },
      });
      await request(app.getHttpServer()).get(`/api${image}`).expect(404);
    },
  );

  it.each([null, 'Bearer invalid.jwt.token'])(
    'rejects missing or invalid authentication: %j',
    async (authorization) => {
      await upload('png', authorization).expect(401);
      expect(await generatedFiles()).toEqual([]);
      expect(await ownerAttachments()).toEqual([]);
    },
  );

  it('rejects an expired JWT', async () => {
    const expired = await app
      .get(JwtService)
      .signAsync({ sub: owner.id, jti: randomUUID() }, { expiresIn: -1 });
    await upload('png', `Bearer ${expired}`).expect(401);
    expect(await generatedFiles()).toEqual([]);
  });

  it('rejects a revoked JWT before storing files', async () => {
    const payload = await app
      .get(JwtService)
      .verifyAsync<{ jti: string }>(token);
    revocationKeys.push(`${REVOCATION_KEY_PREFIX}${payload.jti}`);
    await request(app.getHttpServer())
      .post('/api/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await upload().expect(401);
    expect(await generatedFiles()).toEqual([]);
  });

  it('fails closed when Redis is unavailable', async () => {
    jest
      .spyOn(app.get(RedisService), 'isTokenRevoked')
      .mockRejectedValueOnce(new ServiceUnavailableException());
    await upload().expect(503);
    expect(await generatedFiles()).toEqual([]);
  });

  it('requires the avatar file and translates its validation message', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/users/avatar?lang=vi')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(response.body.message).toBe('Vui lòng cung cấp tệp ảnh đại diện');
  });

  it.each([
    'text/html',
    'image/svg+xml',
    'application/javascript',
    'application/octet-stream',
    'image/gif',
  ])('rejects unsupported MIME %s', async (contentType) => {
    await request(app.getHttpServer())
      .put('/api/users/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', buffers.png, { filename: 'avatar.png', contentType })
      .expect(415);
    expect(await generatedFiles()).toEqual([]);
  });

  it.each(['html', 'mismatch', 'corrupt'] as const)(
    'rejects %s content before public storage',
    async (kind) => {
      const buffer =
        kind === 'html'
          ? Buffer.from('<html><script>alert(1)</script></html>')
          : kind === 'mismatch'
            ? buffers.jpeg
            : buffers.png.subarray(0, 40);
      await request(app.getHttpServer())
        .put('/api/users/avatar')
        .set('Authorization', `Bearer ${token}`)
        .attach('avatar', buffer, {
          filename: 'image.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(await generatedFiles()).toEqual([]);
      expect(await ownerAttachments()).toEqual([]);
      expect((await users.findOneByOrFail({ id: owner.id })).image).toBe(
        owner.image,
      );
    },
  );

  it('accepts exactly 5 MiB and publishes only the sanitized image bytes', async () => {
    const input = Buffer.concat([
      buffers.jpeg,
      Buffer.alloc(AVATAR_MAX_BYTES - buffers.jpeg.length),
    ]);
    const response = await request(app.getHttpServer())
      .put('/api/users/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', input, {
        filename: 'maximum.jpg',
        contentType: 'image/jpeg',
      })
      .expect(200);
    const record = (await ownerAttachments())[0];
    expect(Number(record.fileSize)).toBeLessThan(AVATAR_MAX_BYTES);
    await request(app.getHttpServer())
      .get(response.body.user.image)
      .expect(200);
  });

  it('enforces the 5 MiB multipart limit', async () => {
    await request(app.getHttpServer())
      .put('/api/users/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', Buffer.alloc(AVATAR_MAX_BYTES + 1), {
        filename: 'huge.png',
        contentType: 'image/png',
      })
      .expect(413);
    expect(await generatedFiles()).toEqual([]);
    expect(await ownerAttachments()).toEqual([]);
  });

  it.each(['multipart/form-data', 'multipart/form-data; boundary=unfinished'])(
    'handles malformed multipart safely: %s',
    async (contentType) => {
      await request(app.getHttpServer())
        .put('/api/users/avatar')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', contentType)
        .send(
          '--unfinished\r\nContent-Disposition: form-data; name="avatar"; filename="x.png"\r\n',
        )
        .expect(400);
      expect(await generatedFiles()).toEqual([]);
    },
  );

  it('rejects unexpected file fields and multiple files', async () => {
    await request(app.getHttpServer())
      .put('/api/users/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffers.png, {
        filename: 'avatar.png',
        contentType: 'image/png',
      })
      .expect(400);
    await upload()
      .attach('avatar', buffers.png, {
        filename: 'another.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(await generatedFiles()).toEqual([]);
  });

  it('rejects client-supplied owner fields without changing either account', async () => {
    await request(app.getHttpServer())
      .put('/api/users/avatar')
      .set('Authorization', `Bearer ${token}`)
      .field('userId', other.id)
      .attach('avatar', buffers.png, {
        filename: 'avatar.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect((await users.findOneByOrFail({ id: owner.id })).image).toBe(
      owner.image,
    );
    expect((await users.findOneByOrFail({ id: other.id })).image).toBe(
      other.image,
    );
    expect(await generatedFiles()).toEqual([]);
  });

  it.each([
    '/public/avatars/..%2Foutside-secret.txt',
    '/public/avatars/%2e%2e%5coutside-secret.txt',
    '/public/avatars/%2e%2e/.env',
    '/public/avatars/%252e%252e%252f.env',
    '/public/avatars/unrelated.html',
    '/public/avatars/',
  ])('does not serve arbitrary paths: %s', async (path) => {
    const response = await request(app.getHttpServer()).get(path).expect(404);
    expect(response.text).not.toContain('outside-secret');
    expect(response.text).not.toContain('unrelated-file');
  });

  it('returns a clean 404 for a missing generated avatar', async () => {
    await request(app.getHttpServer())
      .get(`/public/avatars/${randomUUID()}.png`)
      .expect('X-Content-Type-Options', 'nosniff')
      .expect(404);
  });

  it('replaces the avatar and removes the superseded metadata and file after commit', async () => {
    const first = await upload('jpeg').expect(200);
    const firstRecord = (await ownerAttachments())[0];
    const second = await upload('webp').expect(200);
    expect(second.body.user.image).not.toBe(first.body.user.image);
    const records = await ownerAttachments();
    expect(records).toHaveLength(1);
    expect(records[0].url).toBe(second.body.user.image);
    expect(await generatedFiles()).toEqual([records[0].fileName]);
    await request(app.getHttpServer()).get(first.body.user.image).expect(404);
    await request(app.getHttpServer()).get(second.body.user.image).expect(200);
    expect(await attachments.findOneBy({ id: firstRecord.id })).toBeNull();
  });

  it.each(['user', 'article'] as const)(
    'preserves old files still referenced by another %s record',
    async (reference) => {
      const first = await upload().expect(200);
      const oldImage = first.body.user.image as string;
      if (reference === 'user') {
        await users.update(other.id, { image: oldImage });
      } else {
        const article = await attachments.save({
          attachableType: 'article',
          attachableId: randomUUID(),
          url: oldImage,
          fileName: 'untrusted-metadata-name',
          fileType: 'image/png',
          fileSize: '1',
        });
        extraAttachmentIds.push(article.id);
      }
      await upload('jpeg').expect(200);
      expect(await ownerAttachments()).toHaveLength(1);
      expect(await generatedFiles()).toHaveLength(2);
      await request(app.getHttpServer()).get(oldImage).expect(200);
    },
  );

  it('rolls back inserted metadata and retains the previous valid avatar when updating User.image fails', async () => {
    const first = await upload().expect(200);
    const previousMetadata = await ownerAttachments();
    const previousFiles = await generatedFiles();
    jest
      .spyOn(EntityManager.prototype, 'update')
      .mockRejectedValueOnce(
        new ServiceUnavailableException('Persistence unavailable'),
      );
    await upload('jpeg').expect(503);
    expect((await users.findOneByOrFail({ id: owner.id })).image).toBe(
      first.body.user.image,
    );
    expect(await ownerAttachments()).toEqual(previousMetadata);
    expect(await generatedFiles()).toEqual(previousFiles);
    await request(app.getHttpServer()).get(first.body.user.image).expect(200);
  });

  it('logs old-file cleanup failures while keeping the new reference and file valid', async () => {
    const first = await upload().expect(200);
    const oldFile = (await ownerAttachments())[0].fileName;
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn(storage, 'remove')
      .mockRejectedValueOnce(new Error('Cleanup access denied'));
    const second = await upload('webp').expect(200);
    expect((await users.findOneByOrFail({ id: owner.id })).image).toBe(
      second.body.user.image,
    );
    expect(await ownerAttachments()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(`Avatar cleanup deferred: ${oldFile}`);
    await request(app.getHttpServer()).get(second.body.user.image).expect(200);
    await request(app.getHttpServer()).get(first.body.user.image).expect(200);
  });

  it('serializes concurrent replacements and leaves exactly one active, readable avatar', async () => {
    await upload('png').expect(200);
    const responses = await Promise.all([upload('jpeg'), upload('webp')]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const current = await users.findOneByOrFail({ id: owner.id });
    const records = await ownerAttachments();
    expect(records).toHaveLength(1);
    expect(records[0].url).toBe(current.image);
    expect(responses.map((response) => response.body.user.image)).toContain(
      current.image,
    );
    expect(await generatedFiles()).toEqual([records[0].fileName]);
    await request(app.getHttpServer()).get(current.image!).expect(200);
  });

  it('does not delete the final avatar when an earlier committed request finishes cleanup late', async () => {
    await upload('png').expect(200);
    const oldFile = (await ownerAttachments())[0].fileName;
    const remove = storage.remove.bind(storage);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanupReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    jest.spyOn(storage, 'remove').mockImplementation(async (name) => {
      if (name === oldFile) {
        reached();
        await gate;
      }
      await remove(name);
    });
    const first = upload('jpeg').then((response) => response);
    try {
      await Promise.race([
        cleanupReached,
        first.then(() => {
          throw new Error('First request did not reach cleanup');
        }),
      ]);
      const final = await upload('webp').expect(200);
      release();
      expect((await first).status).toBe(200);
      expect((await users.findOneByOrFail({ id: owner.id })).image).toBe(
        final.body.user.image,
      );
      const records = await ownerAttachments();
      expect(records).toHaveLength(1);
      expect(records[0].url).toBe(final.body.user.image);
      expect(await generatedFiles()).toEqual([records[0].fileName]);
      await request(app.getHttpServer()).get(final.body.user.image).expect(200);
    } finally {
      release();
      await first;
    }
  });

  it('documents the guarded multipart avatar endpoint and response contract', async () => {
    const docs = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const operation = docs.body.paths['/api/users/avatar'].put;
    expect(operation.security).toEqual([{ bearer: [] }]);
    expect(
      operation.requestBody.content['multipart/form-data'].schema,
    ).toMatchObject({
      required: ['avatar'],
      properties: { avatar: { type: 'string', format: 'binary' } },
    });
    for (const status of ['200', '400', '401', '413', '415', '503'])
      expect(operation.responses).toHaveProperty(status);
  });
});
