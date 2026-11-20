import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { INVALID_USER_PASSWORD_HASH } from '../src/auth/constants/auth.constant';
import { Follow } from '../src/database/entities/follow.entity';
import { User } from '../src/database/entities/user.entity';

describe('Follow relationships (database e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let followsRepository: Repository<Follow>;
  let usersRepository: Repository<User>;
  let follower: User;
  let following: User;
  let other: User;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    dataSource = app.get(DataSource);
    // Never write fixtures or test deletions outside the isolated test database.
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

    usersRepository = dataSource.getRepository(User);
    followsRepository = dataSource.getRepository(Follow);
  });

  beforeEach(async () => {
    const users = Array.from({ length: 3 }, () => {
      const id = randomUUID();
      createdIds.push(id);
      return usersRepository.create({
        id,
        username: `follow_${id}`,
        email: `follow_${id}@example.test`,
        passwordHash: INVALID_USER_PASSWORD_HASH,
        bio: null,
        image: null,
      });
    });
    [follower, following, other] = await usersRepository.save(users);
  });

  afterEach(async () => {
    if (createdIds.length > 0) {
      // Foreign-key cascades remove only relationships involving these fixtures.
      await usersRepository.delete({ id: In(createdIds) });
      createdIds.length = 0;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('matches the entity metadata to the manual migration schema', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      const table = await queryRunner.getTable('follows');
      expect(table).toBeDefined();
      for (const name of ['id', 'follower_id', 'following_id']) {
        expect(table!.findColumnByName(name)).toMatchObject({
          type: 'varchar',
          length: '36',
          isNullable: false,
        });
      }
      expect(table!.primaryColumns.map((column) => column.name)).toEqual([
        'id',
      ]);
      expect(table!.findColumnByName('created_at')).toMatchObject({
        type: 'datetime',
        precision: 3,
        isNullable: false,
      });
      expect(table!.indices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'IDX_follows_follower_following_unique',
            columnNames: ['follower_id', 'following_id'],
            isUnique: true,
          }),
          expect.objectContaining({
            name: 'IDX_follows_following_id',
            columnNames: ['following_id'],
          }),
        ]),
      );
      for (const name of ['follower_id', 'following_id']) {
        expect(table!.foreignKeys).toContainEqual(
          expect.objectContaining({
            name: `FK_follows_${name}`,
            columnNames: [name],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
          }),
        );
      }

      const metadata = dataSource.getMetadata(Follow);
      expect(metadata.relations).toHaveLength(2);
      for (const relation of metadata.relations) {
        expect(relation.relationType).toBe('many-to-one');
        expect(relation.isNullable).toBe(false);
        expect(relation.isEager).toBe(false);
        expect(relation.isCascadeInsert).toBe(false);
        expect(relation.isCascadeUpdate).toBe(false);
        const foreignKey = relation.foreignKeys[0];
        expect(table!.foreignKeys).toContainEqual(
          expect.objectContaining({
            name: foreignKey.name,
            columnNames: foreignKey.columnNames,
            referencedColumnNames: foreignKey.referencedColumnNames,
            onDelete: foreignKey.onDelete,
            onUpdate: foreignKey.onUpdate,
          }),
        );
      }
    } finally {
      await queryRunner.release();
    }
  });

  it('persists UUIDs and resolves the follower and following in the correct direction', async () => {
    const follow = await followsRepository.save({
      followerId: follower.id,
      followingId: following.id,
    });
    expect(follow.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(follow.createdAt).toBeInstanceOf(Date);
    const stored = await followsRepository.findOneOrFail({
      where: { id: follow.id },
      relations: { follower: true, following: true },
    });
    expect(stored.follower.id).toBe(follower.id);
    expect(stored.following.id).toBe(following.id);
    expect(stored.follower.passwordHash).toBeUndefined();
    expect(stored.following.passwordHash).toBeUndefined();
  });

  it('rejects a duplicate pair at the database layer', async () => {
    const pair = { followerId: follower.id, followingId: following.id };
    await followsRepository.insert(pair);
    await expect(followsRepository.insert(pair)).rejects.toMatchObject({
      driverError: { code: 'ER_DUP_ENTRY' },
    });
    expect(await followsRepository.countBy(pair)).toBe(1);
  });

  it('allows only one of two concurrent inserts for the same pair', async () => {
    const pair = { followerId: follower.id, followingId: following.id };
    const results = await Promise.allSettled([
      followsRepository.insert(pair),
      followsRepository.insert(pair),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(QueryFailedError);
    expect(rejected[0].reason).toMatchObject({
      driverError: { code: 'ER_DUP_ENTRY' },
    });
    expect(await followsRepository.countBy(pair)).toBe(1);
  });

  it('allows reciprocal follows and multiple incoming and outgoing relationships', async () => {
    await followsRepository.insert([
      { followerId: follower.id, followingId: following.id },
      { followerId: following.id, followingId: follower.id },
      { followerId: follower.id, followingId: other.id },
      { followerId: other.id, followingId: following.id },
    ]);
    expect(await followsRepository.countBy({ followerId: follower.id })).toBe(
      2,
    );
    expect(await followsRepository.countBy({ followingId: following.id })).toBe(
      2,
    );
  });

  it.each(['followerId', 'followingId'] as const)(
    'rejects a nonexistent user in %s',
    async (field) => {
      const pair = {
        followerId: follower.id,
        followingId: following.id,
        [field]: randomUUID(),
      };
      await expect(followsRepository.insert(pair)).rejects.toMatchObject({
        driverError: { code: 'ER_NO_REFERENCED_ROW_2' },
      });
      expect(await followsRepository.countBy({ followerId: follower.id })).toBe(
        0,
      );
      expect(
        await followsRepository.countBy({ followingId: following.id }),
      ).toBe(0);
    },
  );

  it.each(['follower_id', 'following_id'] as const)(
    'rejects null %s values',
    async (column) => {
      const followerId = column === 'follower_id' ? null : follower.id;
      const followingId = column === 'following_id' ? null : following.id;
      await expect(
        dataSource.query(
          'INSERT INTO follows (id, follower_id, following_id) VALUES (?, ?, ?)',
          [randomUUID(), followerId, followingId],
        ),
      ).rejects.toMatchObject({ driverError: { code: 'ER_BAD_NULL_ERROR' } });
    },
  );

  it.each(['follower', 'following'] as const)(
    'cascades when the %s is deleted and preserves unrelated relationships',
    async (role) => {
      const follow = await followsRepository.save({
        followerId: follower.id,
        followingId: following.id,
      });
      const deletedUser = role === 'follower' ? follower : following;
      const survivor = role === 'follower' ? following : follower;
      const unrelated = await followsRepository.save({
        followerId: survivor.id,
        followingId: other.id,
      });
      await usersRepository.delete(deletedUser.id);
      expect(await followsRepository.findOneBy({ id: follow.id })).toBeNull();
      expect(
        await followsRepository.findOneBy({ id: unrelated.id }),
      ).not.toBeNull();
      expect(
        await usersRepository.findOneBy({ id: survivor.id }),
      ).not.toBeNull();
      expect(await usersRepository.findOneBy({ id: other.id })).not.toBeNull();
    },
  );

  it('deletes a relationship without deleting either user and permits a later follow', async () => {
    const pair = { followerId: follower.id, followingId: following.id };
    await followsRepository.insert(pair);
    await followsRepository.delete(pair);
    expect(await followsRepository.countBy(pair)).toBe(0);
    expect(await usersRepository.countBy({ id: In(createdIds) })).toBe(3);
    await followsRepository.insert(pair);
    expect(await followsRepository.countBy(pair)).toBe(1);
  });

  it('restricts changing a referenced user ID', async () => {
    const pair = { followerId: follower.id, followingId: following.id };
    await followsRepository.insert(pair);
    await expect(
      usersRepository.update(follower.id, { id: randomUUID() }),
    ).rejects.toMatchObject({
      driverError: { code: 'ER_ROW_IS_REFERENCED_2' },
    });
    expect(await followsRepository.countBy(pair)).toBe(1);
    expect(await usersRepository.findOneBy({ id: follower.id })).not.toBeNull();
  });
});
