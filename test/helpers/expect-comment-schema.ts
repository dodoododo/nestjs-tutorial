import { DataSource } from 'typeorm';
import { Article } from '../../src/database/entities/article.entity';
import { Comment } from '../../src/database/entities/comment.entity';
import { User } from '../../src/database/entities/user.entity';

/** Read-only assertions shared by normal E2E and the disposable roundtrip. */
export async function expectCommentSchema(
  dataSource: DataSource,
): Promise<void> {
  const runner = dataSource.createQueryRunner();
  try {
    const table = (await runner.getTable('comments'))!;
    const metadata = dataSource.getMetadata(Comment);
    expect(table).toBeDefined();
    const columns = [
      'id',
      'article_id',
      'author_id',
      'body',
      'created_at',
      'updated_at',
    ];
    expect(table.columns.map((column) => column.name).sort()).toEqual(
      [...columns].sort(),
    );
    expect(
      metadata.columns.map((column) => column.databaseName).sort(),
    ).toEqual([...columns].sort());
    expect(table.columns.every((column) => !column.isNullable)).toBe(true);
    expect(table.primaryColumns.map((column) => column.name)).toEqual(['id']);
    expect(
      metadata.primaryColumns.map((column) => column.databaseName),
    ).toEqual(['id']);
    expect(
      metadata.generatedColumns.map((column) => [
        column.databaseName,
        column.generationStrategy,
      ]),
    ).toEqual([['id', 'uuid']]);
    for (const name of ['id', 'article_id', 'author_id'])
      expect(table.findColumnByName(name)).toMatchObject({
        type: 'varchar',
        length: '36',
        isNullable: false,
      });
    expect(table.findColumnByName('body')).toMatchObject({
      type: 'text',
      isNullable: false,
    });
    for (const name of ['created_at', 'updated_at']) {
      const column = table.findColumnByName(name)!;
      expect(column).toMatchObject({
        type: 'datetime',
        precision: 3,
        isNullable: false,
      });
      expect(String(column.default).toUpperCase()).toContain(
        'CURRENT_TIMESTAMP(3)',
      );
    }
    expect(table.findColumnByName('updated_at')!.onUpdate?.toUpperCase()).toBe(
      'CURRENT_TIMESTAMP(3)',
    );
    const expectedIndexes = [
      {
        name: 'IDX_comments_article_created_at_id',
        columnNames: ['article_id', 'created_at', 'id'],
        isUnique: false,
      },
      {
        name: 'IDX_comments_author_id',
        columnNames: ['author_id'],
        isUnique: false,
      },
    ];
    expect(table.indices).toHaveLength(expectedIndexes.length);
    for (const index of expectedIndexes) {
      expect(table.indices).toContainEqual(expect.objectContaining(index));
      expect(
        metadata.indices.map((entry) => ({
          name: entry.name,
          columnNames: entry.columns.map((column) => column.databaseName),
          isUnique: entry.isUnique,
        })),
      ).toContainEqual(index);
    }
    expect(table.foreignKeys).toHaveLength(2);
    for (const [column, parent] of [
      ['article_id', 'articles'],
      ['author_id', 'users'],
    ]) {
      expect(table.foreignKeys).toContainEqual(
        expect.objectContaining({
          name: `FK_comments_${column}`,
          columnNames: [column],
          referencedTableName: parent,
          referencedColumnNames: ['id'],
          onDelete: 'CASCADE',
          onUpdate: 'RESTRICT',
        }),
      );
    }
    expect(
      metadata.relations.map((relation) => relation.propertyName).sort(),
    ).toEqual(['article', 'author']);
    for (const relation of metadata.relations) {
      expect(relation.relationType).toBe('many-to-one');
      expect(relation.isEager).toBe(false);
      expect(relation.isCascadeInsert).toBe(false);
      expect(relation.isCascadeUpdate).toBe(false);
      expect(relation.isCascadeRemove).toBe(false);
    }
    const articleTable = (await runner.getTable('articles'))!;
    expect(
      articleTable.columns.some((column) => /comment/i.test(column.name)),
    ).toBe(false);
    expect(
      dataSource
        .getMetadata(Article)
        .relations.some(
          (relation) => relation.inverseEntityMetadata.target === Comment,
        ),
    ).toBe(false);
    expect(
      dataSource
        .getMetadata(User)
        .relations.some(
          (relation) => relation.inverseEntityMetadata.target === Comment,
        ),
    ).toBe(false);
  } finally {
    await runner.release();
  }
}
