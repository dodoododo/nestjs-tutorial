import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { INVALID_USER_PASSWORD_HASH } from '../src/auth/constants/auth.constant';
import { Attachment } from '../src/database/entities/attachment.entity';
import { User } from '../src/database/entities/user.entity';
import { expectAttachmentSchema } from './helpers/expect-attachment-schema';

describe('Polymorphic attachments (database e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let attachmentsRepository: Repository<Attachment>;
  let usersRepository: Repository<User>;
  const attachmentIds: string[] = [];
  const userIds: string[] = [];

  function metadata(overrides: Partial<Attachment> = {}) {
    return {
      attachableType: 'user',
      attachableId: randomUUID(),
      url: `/uploads/avatars/${randomUUID()}.png`,
      fileName: 'original-avatar.png',
      fileType: 'image/png',
      fileSize: '1024',
      ...overrides,
    };
  }

  async function saveAttachment(overrides: Partial<Attachment> = {}) {
    const attachment = await attachmentsRepository.save(metadata(overrides));
    attachmentIds.push(attachment.id);
    return attachment;
  }

  async function createUser() {
    const id = randomUUID();
    userIds.push(id);
    return usersRepository.save({
      id,
      username: `attach_${id}`,
      email: `attach_${id}@example.test`,
      passwordHash: INVALID_USER_PASSWORD_HASH,
      image: '/existing-avatar.png',
      bio: null,
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);

    // Check isolation before fixture writes. DDL runs in the disposable suite.
    if (
      process.env.NODE_ENV !== 'test' ||
      dataSource.options.type !== 'mysql' ||
      dataSource.options.host !== '127.0.0.1' ||
      dataSource.options.port !== 3308 ||
      dataSource.options.database !== 'nestjs_tutorial_test' ||
      dataSource.options.synchronize !== false ||
      dataSource.options.migrationsRun !== false
    ) {
      throw new Error('Unsafe test database configuration');
    }
    if (await dataSource.showMigrations())
      throw new Error(
        'Apply migrations to the guarded E2E database before testing',
      );
    attachmentsRepository = dataSource.getRepository(Attachment);
    usersRepository = dataSource.getRepository(User);
  });

  afterEach(async () => {
    if (attachmentIds.length > 0) {
      await attachmentsRepository.delete({ id: In(attachmentIds) });
      attachmentIds.length = 0;
    }
    if (userIds.length > 0) {
      await usersRepository.delete({ id: In(userIds) });
      userIds.length = 0;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('matches the required columns, unsigned size and polymorphic index to the migration', async () => {
    await expectAttachmentSchema(dataSource);
  });

  it('creates valid metadata with a generated UUID and timestamp', async () => {
    const attachment = await saveAttachment();
    expect(attachment.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const stored = await attachmentsRepository.findOneByOrFail({
      id: attachment.id,
    });
    expect(stored).toMatchObject({
      attachableType: 'user',
      attachableId: attachment.attachableId,
      url: attachment.url,
      fileName: 'original-avatar.png',
      fileType: 'image/png',
      fileSize: '1024',
    });
    expect(stored.createdAt).toBeInstanceOf(Date);
  });

  it('queries by both owner type and UUID without assuming a users foreign key', async () => {
    const ownerId = randomUUID();
    const userAttachment = await saveAttachment({
      attachableType: 'user',
      attachableId: ownerId,
    });
    const articleAttachment = await saveAttachment({
      attachableType: 'article',
      attachableId: ownerId,
    });
    await saveAttachment({
      attachableType: 'user',
      attachableId: randomUUID(),
    });
    for (const [type, attachment] of [
      ['user', userAttachment],
      ['article', articleAttachment],
    ] as const) {
      const matches = await attachmentsRepository.find({
        where: { attachableType: type, attachableId: ownerId },
        select: { id: true, url: true, fileName: true },
      });
      expect(matches).toEqual([
        expect.objectContaining({
          id: attachment.id,
          url: attachment.url,
          fileName: attachment.fileName,
        }),
      ]);
    }
  });

  it('allows multiple attachments per owner', async () => {
    const ownerId = randomUUID();
    await saveAttachment({ attachableType: 'article', attachableId: ownerId });
    await saveAttachment({ attachableType: 'article', attachableId: ownerId });
    expect(
      await attachmentsRepository.countBy({
        attachableType: 'article',
        attachableId: ownerId,
      }),
    ).toBe(2);
  });

  it.each(['0', '1024', '9007199254740993', '18446744073709551615'])(
    'roundtrips file size %s as an exact decimal string',
    async (fileSize) => {
      const attachment = await saveAttachment({ fileSize });
      const stored = await attachmentsRepository.findOneByOrFail({
        id: attachment.id,
      });
      expect(typeof stored.fileSize).toBe('string');
      expect(stored.fileSize).toBe(fileSize);
    },
  );

  it.each(['-1', '18446744073709551616'])(
    'rejects out-of-range file size %s',
    async (fileSize) => {
      await expect(saveAttachment({ fileSize })).rejects.toMatchObject({
        driverError: { code: 'ER_WARN_DATA_OUT_OF_RANGE' },
      });
    },
  );

  it.each([
    'id',
    'attachable_type',
    'attachable_id',
    'url',
    'file_name',
    'file_type',
    'file_size',
    'created_at',
  ])('rejects null %s', async (column) => {
    const columns = [
      'id',
      'attachable_type',
      'attachable_id',
      'url',
      'file_name',
      'file_type',
      'file_size',
      'created_at',
    ];
    const id = randomUUID();
    attachmentIds.push(id);
    const values: (string | Date | null)[] = [
      id,
      'user',
      randomUUID(),
      '/uploads/avatar.png',
      'avatar.png',
      'image/png',
      '1024',
      new Date(),
    ];
    values[columns.indexOf(column)] = null;
    await expect(
      dataSource.query(
        'INSERT INTO attachments (id, attachable_type, attachable_id, url, file_name, file_type, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        values,
      ),
    ).rejects.toMatchObject({ driverError: { code: 'ER_BAD_NULL_ERROR' } });
  });

  it('rejects missing required metadata', async () => {
    const id = randomUUID();
    attachmentIds.push(id);
    await expect(
      dataSource.query('INSERT INTO attachments (id) VALUES (?)', [id]),
    ).rejects.toMatchObject({
      driverError: { code: 'ER_NO_DEFAULT_FOR_FIELD' },
    });
  });

  it.each([
    { attachableType: 'a'.repeat(51) },
    { attachableId: 'a'.repeat(37) },
    { url: 'a'.repeat(2049) },
    { fileName: 'a'.repeat(256) },
    { fileType: 'a'.repeat(128) },
  ])('rejects metadata exceeding the column lengths: %j', async (fields) => {
    await expect(saveAttachment(fields)).rejects.toMatchObject({
      driverError: { code: 'ER_DATA_TOO_LONG' },
    });
  });

  it('enforces unique attachment identifiers', async () => {
    const attachment = await saveAttachment();
    await expect(
      attachmentsRepository.insert(metadata({ id: attachment.id })),
    ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
  });

  it('stores user metadata without implicitly changing User.image', async () => {
    const user = await createUser();
    const before = await usersRepository.findOneByOrFail({ id: user.id });
    await saveAttachment({ attachableType: 'user', attachableId: user.id });
    expect(await usersRepository.findOneByOrFail({ id: user.id })).toEqual(
      before,
    );
  });
});
