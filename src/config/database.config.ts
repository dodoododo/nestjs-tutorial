import { ConfigService } from '@nestjs/config';
import Joi from 'joi';
import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';

const databaseEnvSchema = Joi.object({
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().integer().min(1).max(65535).required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().min(1).required(),
  DB_NAME: Joi.string().required(),
}).unknown(true);

export function validateDatabaseEnvironment(
  environment: Record<string, unknown>,
): Record<string, unknown> {
  const { error, value } = databaseEnvSchema.validate(environment, {
    abortEarly: false,
  });

  if (error) {
    throw error;
  }

  if (value.NODE_ENV === 'test' && !String(value.DB_NAME).endsWith('_test')) {
    throw new Error('Test database name must end with _test');
  }

  return value as Record<string, unknown>;
}

export function createDatabaseOptions(
  config: ConfigService,
): DataSourceOptions {
  const databasePath = join(__dirname, '..', 'database').replaceAll('\\', '/');

  return {
    type: 'mysql',
    host: config.getOrThrow<string>('DB_HOST'),
    port: Number(config.getOrThrow<string>('DB_PORT')),
    username: config.getOrThrow<string>('DB_USER'),
    password: config.getOrThrow<string>('DB_PASSWORD'),
    database: config.getOrThrow<string>('DB_NAME'),

    entities: [`${databasePath}/entities/*.entity{.ts,.js}`],
    migrations: [`${databasePath}/migrations/*{.ts,.js}`],

    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
  };
}
