import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { INVALID_USER_PASSWORD_HASH } from '../src/auth/constants/auth.constant';
import { Attachment } from '../src/database/entities/attachment.entity';
import { Follow } from '../src/database/entities/follow.entity';
import { User } from '../src/database/entities/user.entity';
import { CreateAttachments1795173453495 } from '../src/database/migrations/1795173453495-CreateAttachments';

describe('Polymorphic attachments (database e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let attachmentsRepository: Repository<Attachment>;
  let usersRepository: Repository<User>;
  let followsRepository: Repository<Follow>;
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

    // Check isolation before any writes or migration roundtrip. No schema sync.
    if (
      process.env.NODE_ENV !== 'test' ||
      dataSource.options.type !== 'mysql' ||
      dataSource.options.host !== '127.0.0.1' ||
      dataSource.options.port !== 3308 ||
      dataSource.options.database !== 'nestjs_tutorial_test' ||
      dataSource.options.synchronize !== false
    ) {
      throw new Error('Unsafe test database configuration');
    }
    attachmentsRepository = dataSource.getRepository(Attachment);
    usersRepository = dataSource.getRepository(User);
    followsRepository = dataSource.getRepository(Follow);
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

  // Allow real MySQL DDL and restoration to finish before the next test starts.
  it('runs down/up without changing users or follows and allows repeated migration runs', async () => {
    // Never drop preexisting attachment metadata, even in the test database.
    if ((await attachmentsRepository.count()) !== 0) {
      throw new Error(
        'Migration roundtrip requires an empty attachments table',
      );
    }
    expect(await dataSource.showMigrations()).toBe(false);
    const owner = await createUser();
    const follower = await createUser();
    const follow = await followsRepository.save({
      followerId: follower.id,
      followingId: owner.id,
    });
    const usersBefore = await usersRepository.findBy({ id: In(userIds) });
    const followsBefore = await followsRepository.findBy({ id: follow.id });
    const usersSchema = await dataSource.query('SHOW CREATE TABLE users');
    const followsSchema = await dataSource.query('SHOW CREATE TABLE follows');
    const runner = dataSource.createQueryRunner();
    const migration = new CreateAttachments1795173453495();
    let dropped = false;
    try {
      await migration.down(runner);
      dropped = true;
      expect(await runner.hasTable('attachments')).toBe(false);
      expect(await usersRepository.findBy({ id: In(userIds) })).toEqual(
        usersBefore,
      );
      expect(await followsRepository.findBy({ id: follow.id })).toEqual(
        followsBefore,
      );
      await migration.up(runner);
      dropped = false;
      expect(await runner.hasTable('attachments')).toBe(true);
      expect(await dataSource.runMigrations({ transaction: 'none' })).toEqual(
        [],
      );
      expect(await dataSource.query('SHOW CREATE TABLE users')).toEqual(
        usersSchema,
      );
      expect(await dataSource.query('SHOW CREATE TABLE follows')).toEqual(
        followsSchema,
      );
      expect(await usersRepository.findBy({ id: In(userIds) })).toEqual(
        usersBefore,
      );
      expect(await followsRepository.findBy({ id: follow.id })).toEqual(
        followsBefore,
      );
    } finally {
      try {
        if (dropped && !(await runner.hasTable('attachments'))) {
          await migration.up(runner);
        }
      } finally {
        await runner.release();
      }
    }
  }, 30_000);

  it('matches the required columns, unsigned size and polymorphic index to the migration', async () => {
    const runner = dataSource.createQueryRunner();
    try {
      const table = await runner.getTable('attachments');
      expect(table).toBeDefined();
      expect(table!.primaryColumns.map((column) => column.name)).toEqual([
        'id',
      ]);
      const columns: Record<string, number> = {
        id: 36,
        attachable_type: 50,
        attachable_id: 36,
        url: 2048,
        file_name: 255,
        file_type: 127,
      };
      for (const [name, length] of Object.entries(columns)) {
        expect(table!.findColumnByName(name)).toMatchObject({
          type: 'varchar',
          length: String(length),
          isNullable: false,
        });
      }
      expect(table!.findColumnByName('file_size')).toMatchObject({
        type: 'bigint',
        unsigned: true,
        isNullable: false,
      });
      expect(table!.findColumnByName('created_at')).toMatchObject({
        type: 'datetime',
        precision: 3,
        isNullable: false,
      });
      expect(table!.foreignKeys).toHaveLength(0);
      expect(table!.indices).toEqual([
        expect.objectContaining({
          name: 'IDX_attachments_attachable_type_id',
          columnNames: ['attachable_type', 'attachable_id'],
          isUnique: false,
        }),
      ]);
      const entity = dataSource.getMetadata(Attachment);
      expect(entity.relations).toHaveLength(0);
      expect(
        entity.indices[0].columns.map((column) => column.databaseName),
      ).toEqual(['attachable_type', 'attachable_id']);
      expect(entity.indices[0].isUnique).toBe(false);
    } finally {
      await runner.release();
    }
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
