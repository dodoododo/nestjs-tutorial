import { articleMigrationTarget } from './article-migration-target';

describe('Disposable Article migration target guards', () => {
  const valid = {
    NODE_ENV: 'test',
    ARTICLE_MIGRATION_DISPOSABLE: 'a'.repeat(32),
    ARTICLE_MIGRATION_DB_PORT: '49152',
    ARTICLE_MIGRATION_DB_PASSWORD: 'b'.repeat(64),
    ARTICLE_MIGRATION_SERVER_UUID: '12345678-1234-1234-1234-123456789abc',
    ARTICLE_MIGRATION_CONTAINER_ID: 'c'.repeat(64),
  };

  it.each([
    ['NODE_ENV', 'production'],
    ['ARTICLE_MIGRATION_DISPOSABLE', undefined],
    ['ARTICLE_MIGRATION_DB_PORT', '3306'],
    ['ARTICLE_MIGRATION_DB_PORT', '3307'],
    ['ARTICLE_MIGRATION_DB_PORT', '3308'],
    ['ARTICLE_MIGRATION_DB_PORT', '49152.5'],
    ['ARTICLE_MIGRATION_DB_PORT', '65536'],
    ['ARTICLE_MIGRATION_DB_PORT', undefined],
    ['ARTICLE_MIGRATION_DB_PASSWORD', undefined],
    ['ARTICLE_MIGRATION_SERVER_UUID', undefined],
    ['ARTICLE_MIGRATION_CONTAINER_ID', undefined],
  ])('refuses %s=%s before connecting', (key, value) => {
    expect(() => articleMigrationTarget({ ...valid, [key!]: value })).toThrow(
      'Unsafe migration target',
    );
  });

  it('ignores ordinary database credentials and fixes the dedicated host, schema and non-root user', () => {
    const target = articleMigrationTarget({
      ...valid,
      DB_HOST: 'production.example.test',
      DB_PORT: '3306',
      DB_NAME: 'nestjs_tutorial_test',
      DB_USER: 'root',
      DB_PASSWORD: 'shared-secret',
    });
    expect(target).toMatchObject({
      host: '127.0.0.1',
      port: 49152,
      database: 'nestjs_article_migration_test',
      username: 'article_migration_test',
    });
    expect(target.password).toBe(valid.ARTICLE_MIGRATION_DB_PASSWORD);
  });
});
