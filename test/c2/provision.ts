import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../../src/config/database.config';
import { assertC2DatabaseOptions } from './helpers/c2-database';
import {
  C2_DATABASE,
  C2_DATABASE_USER,
  C2_MYSQL_HOST,
  C2_MYSQL_PORT,
  C2SafetyError,
  readC2Environment,
} from './helpers/c2-environment';

async function provision(): Promise<void> {
  const environment = readC2Environment();
  if (!environment.C2_DB_ADMIN_USER || !environment.C2_DB_ADMIN_PASSWORD)
    throw new C2SafetyError('C2 provisioning requires test-admin credentials');
  const options = createDatabaseOptions(new ConfigService(environment));
  assertC2DatabaseOptions(options);
  const admin = await createConnection({
    host: C2_MYSQL_HOST,
    port: C2_MYSQL_PORT,
    user: environment.C2_DB_ADMIN_USER,
    password: environment.C2_DB_ADMIN_PASSWORD,
    multipleStatements: false,
  });
  let dataSource: DataSource | undefined;
  // Database-level grants interpret underscores as wildcards unless escaped.
  const grantDatabase = C2_DATABASE.replaceAll('_', '\\_');
  try {
    const [lease] = await admin.query('SELECT GET_LOCK(?, 0) AS acquired', [
      `${C2_DATABASE}:lifecycle`,
    ]);
    if ((lease as { acquired: number | null }[])[0].acquired !== 1)
      throw new C2SafetyError('Another C2 process owns this schema');
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${C2_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    // Values are escaped by mysql2.query; schema identifiers are fixed constants.
    // Existing account passwords are never changed by this repeatable setup.
    await admin.query("CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?", [
      C2_DATABASE_USER,
      environment.DB_PASSWORD,
    ]);
    const [grants] = await admin.query("SHOW GRANTS FOR ?@'%'", [
      C2_DATABASE_USER,
    ]);
    for (const grant of grants as Record<string, string>[]) {
      const statement = Object.values(grant)[0];
      if (
        !statement.startsWith('GRANT USAGE ON *.* ') &&
        !statement.startsWith(`GRANT ALL PRIVILEGES ON \`${grantDatabase}\`.* `)
      )
        throw new C2SafetyError(
          'C2 account has unexpected existing privileges',
        );
    }
    await admin.query(
      `GRANT ALL PRIVILEGES ON \`${grantDatabase}\`.* TO ?@'%'`,
      [C2_DATABASE_USER],
    );
    dataSource = await new DataSource(options).initialize();
    const [{ currentDatabase }] = (await dataSource.query(
      'SELECT DATABASE() AS currentDatabase',
    )) as { currentDatabase: string }[];
    if (currentDatabase !== C2_DATABASE)
      throw new C2SafetyError(
        'C2 migration connection selected an unsafe schema',
      );
    // Existing manual migrations only. MySQL DDL is not transactionally atomic.
    const migrations = await dataSource.runMigrations({ transaction: 'none' });
    console.log(
      `C2 schema ready: ${C2_DATABASE}; applied ${migrations.length} migration(s)`,
    );
  } finally {
    try {
      if (dataSource?.isInitialized) await dataSource.destroy();
    } finally {
      // Disconnecting also releases the advisory lease, including on failure.
      await admin.end();
    }
  }
}

void provision().catch((error: unknown) => {
  // Driver errors can contain DDL parameters/passwords: never print raw errors.
  console.error(
    error instanceof C2SafetyError
      ? error.message
      : 'C2 schema provisioning failed',
  );
  process.exitCode = 1;
});
