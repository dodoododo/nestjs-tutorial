import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class CreateArticles1795178319697 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'articles',
        columns: [
          {
            name: 'id',
            type: 'varchar',
            length: '36',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'slug', type: 'varchar', length: '255' },
          { name: 'title', type: 'varchar', length: '255' },
          { name: 'description', type: 'varchar', length: '1024' },
          { name: 'body', type: 'text' },
          { name: 'author_id', type: 'varchar', length: '36' },
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
            name: 'IDX_articles_slug_unique',
            columnNames: ['slug'],
            isUnique: true,
          }),
          new TableIndex({
            name: 'IDX_articles_created_at_id',
            columnNames: ['created_at', 'id'],
          }),
          new TableIndex({
            name: 'IDX_articles_author_created_at_id',
            columnNames: ['author_id', 'created_at', 'id'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'FK_articles_author_id',
            columnNames: ['author_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
          }),
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'tags',
        columns: [
          {
            name: 'id',
            type: 'varchar',
            length: '36',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'name', type: 'varchar', length: '64' },
        ],
        indices: [
          new TableIndex({
            name: 'IDX_tags_name_unique',
            columnNames: ['name'],
            isUnique: true,
          }),
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'article_tags',
        columns: [
          {
            name: 'article_id',
            type: 'varchar',
            length: '36',
            isPrimary: true,
          },
          { name: 'tag_id', type: 'varchar', length: '36', isPrimary: true },
        ],
        indices: [
          new TableIndex({
            name: 'IDX_article_tags_tag_article',
            columnNames: ['tag_id', 'article_id'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'FK_article_tags_article_id',
            columnNames: ['article_id'],
            referencedTableName: 'articles',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
          }),
          new TableForeignKey({
            name: 'FK_article_tags_tag_id',
            columnNames: ['tag_id'],
            referencedTableName: 'tags',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
          }),
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'article_favorites',
        columns: [
          { name: 'user_id', type: 'varchar', length: '36', isPrimary: true },
          {
            name: 'article_id',
            type: 'varchar',
            length: '36',
            isPrimary: true,
          },
        ],
        indices: [
          new TableIndex({
            name: 'IDX_article_favorites_article_user',
            columnNames: ['article_id', 'user_id'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'FK_article_favorites_user_id',
            columnNames: ['user_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
          }),
          new TableForeignKey({
            name: 'FK_article_favorites_article_id',
            columnNames: ['article_id'],
            referencedTableName: 'articles',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
          }),
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('article_favorites');
    await queryRunner.dropTable('article_tags');
    await queryRunner.dropTable('tags');
    await queryRunner.dropTable('articles');
  }
}
