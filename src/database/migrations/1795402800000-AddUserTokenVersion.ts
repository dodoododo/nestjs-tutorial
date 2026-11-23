import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddUserTokenVersion1795402800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'users',
      new TableColumn({
        name: 'token_version',
        type: 'int',
        unsigned: true,
        isNullable: false,
        default: 0,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('users', 'token_version');
  }
}
