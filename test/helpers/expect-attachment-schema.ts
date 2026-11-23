import { DataSource } from 'typeorm';
import { Attachment } from '../../src/database/entities/attachment.entity';

/** Read-only checks retained in normal E2E and repeated after disposable DDL. */
export async function expectAttachmentSchema(
  dataSource: DataSource,
): Promise<void> {
  const runner = dataSource.createQueryRunner();
  try {
    const table = await runner.getTable('attachments');
    expect(table).toBeDefined();
    expect(table!.primaryColumns.map((column) => column.name)).toEqual(['id']);
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
}
