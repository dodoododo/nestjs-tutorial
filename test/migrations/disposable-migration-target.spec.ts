import { disposableMigrationTarget } from './disposable-migration-target';

describe.each(['comment', 'attachment'] as const)(
  'Disposable %s migration guards',
  (domain) => {
    const prefix = `${domain.toUpperCase()}_MIGRATION`;
    const valid = {
      NODE_ENV: 'test',
      [`${prefix}_DISPOSABLE`]: 'a'.repeat(32),
      [`${prefix}_DB_PORT`]: '49152',
      [`${prefix}_DB_PASSWORD`]: 'b'.repeat(64),
      [`${prefix}_SERVER_UUID`]: '12345678-1234-1234-1234-123456789abc',
      [`${prefix}_CONTAINER_ID`]: 'c'.repeat(64),
    };

    it.each([
      ['NODE_ENV', 'production'],
      [`${prefix}_DISPOSABLE`, undefined],
      [`${prefix}_DB_PORT`, '3306'],
      [`${prefix}_DB_PORT`, '3307'],
      [`${prefix}_DB_PORT`, '3308'],
      [`${prefix}_DB_PORT`, '49152.5'],
      [`${prefix}_DB_PORT`, '65536'],
      [`${prefix}_DB_PORT`, undefined],
      [`${prefix}_DB_PASSWORD`, undefined],
      [`${prefix}_DB_PASSWORD`, 'short'],
      [`${prefix}_SERVER_UUID`, undefined],
      [`${prefix}_SERVER_UUID`, '-'.repeat(36)],
      [`${prefix}_CONTAINER_ID`, undefined],
      [`${prefix}_CONTAINER_ID`, 'c'.repeat(12)],
    ])('rejects %s=%s before connecting', (key, value) => {
      expect(() =>
        disposableMigrationTarget(domain, { ...valid, [key!]: value }),
      ).toThrow('Unsafe migration target');
    });

    it('ignores ordinary credentials and fixes its schema, account and loopback host', () => {
      const target = disposableMigrationTarget(domain, {
        ...valid,
        DB_HOST: 'production.example.test',
        DB_PORT: '3308',
        DB_NAME: 'nestjs_tutorial_test',
        DB_USER: 'root',
        DB_PASSWORD: 'shared-secret',
      });
      expect(target).toEqual({
        host: '127.0.0.1',
        port: 49152,
        database: `nestjs_${domain}_migration_test`,
        username: `${domain}_migration_test`,
        password: valid[`${prefix}_DB_PASSWORD`],
        serverUuid: valid[`${prefix}_SERVER_UUID`],
        serverHostname: 'c'.repeat(12),
      });
    });

    it('rejects credentials issued for a different disposable suite', () => {
      const { NODE_ENV, ...scoped } = valid;
      const other = Object.fromEntries(
        Object.entries(scoped).map(([key, value]) => [
          key.replace(domain.toUpperCase(), 'ARTICLE'),
          value,
        ]),
      );
      expect(() =>
        disposableMigrationTarget(domain, { NODE_ENV, ...other }),
      ).toThrow('Unsafe migration target');
    });
  },
);
