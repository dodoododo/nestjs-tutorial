/** Only the disposable runner supplies these values; never load .env files. */
export function articleMigrationTarget(environment: NodeJS.ProcessEnv) {
  const port = Number(environment.ARTICLE_MIGRATION_DB_PORT);
  const password = environment.ARTICLE_MIGRATION_DB_PASSWORD;
  const serverUuid = environment.ARTICLE_MIGRATION_SERVER_UUID;
  if (
    environment.NODE_ENV !== 'test' ||
    !/^[a-f0-9]{32}$/.test(environment.ARTICLE_MIGRATION_DISPOSABLE ?? '') ||
    !Number.isInteger(port) ||
    port < 32768 ||
    port > 65535 ||
    !/^[a-f0-9]{64}$/.test(password ?? '') ||
    !/^[a-f0-9-]{36}$/.test(serverUuid ?? '')
  ) {
    throw new Error(
      'Unsafe migration target: use npm run test:migration:articles with its disposable MySQL container',
    );
  }
  return {
    host: '127.0.0.1',
    port,
    username: 'article_migration_test',
    password: password!,
    database: 'nestjs_article_migration_test',
    serverUuid: serverUuid!,
  };
}
