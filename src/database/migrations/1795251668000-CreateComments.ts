import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class CreateComments1795251668000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'comments',
        columns: [
          {
            name: 'id',
            type: 'varchar',
            length: '36',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'article_id', type: 'varchar', length: '36' },
          { name: 'author_id', type: 'varchar', length: '36' },
          { name: 'body', type: 'text' },
          {
            name: 'created_at',
            type: 'datetime',
            precision: 3,
            default: 'CURRENT_TIMESTAMP(3)',
          },
          {
            name: 'updated_at',
            type: 'datetime',
            precision: 3,
            default: 'CURRENT_TIMESTAMP(3)',
            onUpdate: 'CURRENT_TIMESTAMP(3)',
          },
        ],
        indices: [
          new TableIndex({
            name: 'IDX_comments_article_created_at_id',
            columnNames: ['article_id', 'created_at', 'id'],
          }),
          new TableIndex({
            name: 'IDX_comments_author_id',
            columnNames: ['author_id'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'FK_comments_article_id',
            columnNames: ['article_id'],
            referencedTableName: 'articles',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
          }),
          new TableForeignKey({
            name: 'FK_comments_author_id',
            columnNames: ['author_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
          }),
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('comments');
  }
}
