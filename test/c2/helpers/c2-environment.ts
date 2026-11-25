import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

export const C2_DATABASE = 'nestjs_tutorial_c2_test';
export const C2_DATABASE_USER = 'nestjs_c2_test';
export const C2_MYSQL_HOST = '127.0.0.1';
export const C2_MYSQL_PORT = 3308;
export const C2_REDIS_HOST = '127.0.0.1';
export const C2_REDIS_PORT = 6380;

export class C2SafetyError extends Error {
  override name = 'C2SafetyError';
}

const applicationKeys = [
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'JWT_SECRET',
  'JWT_TTL_SECONDS',
] as const;

export function readC2Environment(): Record<string, string> {
  if (process.env.NODE_ENV !== 'test')
    throw new C2SafetyError('C2 commands require NODE_ENV=test');
  // No fallback to .env or .env.test, and no credentials in tracked files.
  const environment = parse(readFileSync(resolve('.env.c2.test')));
  if (
    environment.DB_HOST !== C2_MYSQL_HOST ||
    environment.DB_PORT !== String(C2_MYSQL_PORT) ||
    environment.DB_NAME !== C2_DATABASE ||
    environment.DB_USER !== C2_DATABASE_USER ||
    environment.REDIS_HOST !== C2_REDIS_HOST ||
    environment.REDIS_PORT !== String(C2_REDIS_PORT)
  )
    throw new C2SafetyError(
      'C2 environment does not match the approved services',
    );
  for (const key of applicationKeys)
    if (!environment[key])
      throw new C2SafetyError(`Missing required C2 setting: ${key}`);
  if (
    Buffer.byteLength(environment.JWT_SECRET, 'utf8') < 32 ||
    environment.REDIS_PASSWORD.length < 16 ||
    !Number.isSafeInteger(Number(environment.JWT_TTL_SECONDS)) ||
    Number(environment.JWT_TTL_SECONDS) <= 0
  )
    throw new C2SafetyError('C2 authentication configuration is invalid');
  return environment;
}

export function applyC2Environment(): void {
  const environment = readC2Environment();
  // Override only this dedicated process, before AppModule is imported. Explicit
  // values take precedence over ConfigModule's existing .env.test fallback.
  for (const key of applicationKeys) process.env[key] = environment[key];
}
