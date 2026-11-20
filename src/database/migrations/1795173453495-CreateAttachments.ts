import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateAttachments1795173453495 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'attachments',
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
            name: 'attachable_type',
            type: 'varchar',
            length: '50',
          },
          {
            name: 'attachable_id',
            type: 'varchar',
            length: '36',
          },
          {
            name: 'url',
            type: 'varchar',
            length: '2048',
          },
          {
            name: 'file_name',
            type: 'varchar',
            length: '255',
          },
          {
            name: 'file_type',
            type: 'varchar',
            length: '127',
          },
          {
            name: 'file_size',
            type: 'bigint',
            unsigned: true,
          },
          {
            name: 'created_at',
            type: 'datetime',
            precision: 3,
            default: 'CURRENT_TIMESTAMP(3)',
          },
        ],
        indices: [
          new TableIndex({
            name: 'IDX_attachments_attachable_type_id',
            columnNames: ['attachable_type', 'attachable_id'],
          }),
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('attachments');
  }
}
