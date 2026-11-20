import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class CreateFollows1795172102120 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'follows',
        columns: [
          {
            name: 'id',
            type: 'varchar',
            length: '36',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          {
            name: 'follower_id',
            type: 'varchar',
            length: '36',
          },
          {
            name: 'following_id',
            type: 'varchar',
            length: '36',
          },
          {
            name: 'created_at',
            type: 'datetime',
            precision: 3,
            default: 'CURRENT_TIMESTAMP(3)',
          },
        ],
        indices: [
          // The leftmost follower_id also indexes outgoing follow lookups.
          new TableIndex({
            name: 'IDX_follows_follower_following_unique',
            columnNames: ['follower_id', 'following_id'],
            isUnique: true,
          }),
          new TableIndex({
            name: 'IDX_follows_following_id',
            columnNames: ['following_id'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'FK_follows_follower_id',
            columnNames: ['follower_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'RESTRICT',
          }),
          new TableForeignKey({
            name: 'FK_follows_following_id',
            columnNames: ['following_id'],
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
    await queryRunner.dropTable('follows');
  }
}
