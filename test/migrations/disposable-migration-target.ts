/** No dotenv loading or ordinary DB_* fallback is permitted for DDL tests. */
export function disposableMigrationTarget(
  domain: 'article' | 'comment' | 'attachment',
  environment: NodeJS.ProcessEnv,
) {
  const prefix = `${domain.toUpperCase()}_MIGRATION`;
  const port = Number(environment[`${prefix}_DB_PORT`]);
  const password = environment[`${prefix}_DB_PASSWORD`];
  const serverUuid = environment[`${prefix}_SERVER_UUID`];
  const containerId = environment[`${prefix}_CONTAINER_ID`];
  if (
    !['article', 'comment', 'attachment'].includes(domain) ||
    environment.NODE_ENV !== 'test' ||
    !/^[a-f0-9]{32}$/.test(environment[`${prefix}_DISPOSABLE`] ?? '') ||
    !Number.isInteger(port) ||
    port < 32768 ||
    port > 65535 ||
    !/^[a-f0-9]{64}$/.test(password ?? '') ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(serverUuid ?? '') ||
    !/^[a-f0-9]{64}$/.test(containerId ?? '')
  ) {
    throw new Error(
      `Unsafe migration target: use npm run test:migration:${domain}s with its disposable MySQL container`,
    );
  }
  return {
    host: '127.0.0.1',
    port,
    username: `${domain}_migration_test`,
    password: password!,
    database: `nestjs_${domain}_migration_test`,
    serverUuid: serverUuid!,
    serverHostname: containerId!.slice(0, 12),
  };
}
