# PR6 Commit 1: isolated Profiles E2E lifecycle

This checkpoint provides test infrastructure and smoke coverage. It does not
claim C2 condition coverage; the controller condition matrix belongs to Commit 2.
No business API, application configuration, dependency or historical migration is
changed.

## Dedicated services and setup

The C2 schema is **`nestjs_tutorial_c2_test`**, hosted on the existing test MySQL
service at **`127.0.0.1:3308`**. It is separate from both `nestjs_tutorial_test`
and the development database. The schema-specific account is `nestjs_c2_test`.
Redis reuses the test service at **`127.0.0.1:6380`**, database 0, with unique
C2 token IDs and exact-key cleanup. Development MySQL/Redis are never targets.

The existing `compose.yaml` test profile supplies MySQL 8.4 and Redis 7.4 with
loopback-bound published ports and independent test volumes. If needed, start
only those services using the existing Compose environment settings:

```powershell
docker compose --profile test up -d mysql-test redis-test
```

Create `.env.c2.test` once from `.env.c2.test.example`, then fill in credentials
locally. The real file is ignored. Never overwrite `.env`, `.env.test`, or an
existing `.env.c2.test`. Use a new C2 database password, test Redis credentials,
a JWT secret of at least 32 bytes and a positive JWT lifetime. The provisioning
admin credentials must belong to the test MySQL service. No actual credentials
are committed.

Run from the repository root using **Node.js 26.13.0**:

```powershell
npm.cmd run test:c2:setup
npm.cmd run test:c2
```

`test:c2:setup` explicitly creates the dedicated schema/account, checks that an
existing account has no unexpected grants, grants access only to this schema,
and applies the five existing TypeORM migrations. Underscores in the database
grant are escaped to prevent MySQL grant-pattern wildcard expansion. It never
changes existing account passwords, truncates data or edits other schemas.
It is repeatable: an already-migrated schema applies zero migrations. Only the
provisioning command uses the admin credentials; the application runs with the
schema-specific account. MySQL DDL is not transactionally rollbackable. A failed
setup must be investigated and rerun; the runner does not reset schemas to hide
partial migration failures.

Both commands set `NODE_ENV=test`. The dedicated Jest `setupFiles` hook validates
and loads `.env.c2.test` before importing AppModule. Every required application
setting is explicit and overrides inherited values only inside this test process;
provisioning credentials are excluded. Missing or unsafe configuration fails
before application initialization. The existing application's `.env.test` loading
behavior is unchanged. Synchronization and automatic migrations remain disabled.

## Selection and complete HTTP flow

`test/jest-c2.json` selects only `test/c2/**/*.c2-e2e.ts`. The command runs in band
and caches Jest data under `node_modules/.cache/jest-c2` on the workspace drive.
The normal E2E configuration explicitly excludes `/c2/`; C2 filenames also do
not match its `.e2e-spec.ts` convention. No global destructive hook is installed.

The suite initializes the real AppModule, global `/api` prefix and existing body
parser setup. Supertest requests execute real guards, ProfilesController,
ProfilesService, TypeORM, MySQL and Redis. No controller, service, repository or
successful database response is mocked. One explicitly named infrastructure
failure test rejects a TRUNCATE call to verify FK restoration; its session reads,
FK changes and subsequent cleanup still run against MySQL.

## Lifecycle and safety

`C2DatabaseLifecycle.start()` validates MySQL and Redis, verifies the live schema,
acquires a connection-owned MySQL named lease, checks the exact table inventory
and applied migrations, and cleans the dedicated schema. A second C2 process
fails immediately while that lease is held. Provisioning uses the same lease.
The lease lasts through the suite and is released before application shutdown.

Immediately before **every TRUNCATE**, the helper verifies:

- `NODE_ENV=test` and MySQL engine.
- Exact approved host, port, schema and account.
- `synchronize=false`, `migrationsRun=false`, and no schema-drop option.
- No alternate URL, replica, socket or driver-extra connection override.
- The pinned physical connection's `DATABASE()` is the exact C2 schema.
- That connection still owns the C2 lease and has no active transaction.

The dedicated account cannot select the existing shared E2E schema. The guard
does not accept an arbitrary name ending in `_test`. Unexpected/missing tables
fail closed instead of being silently omitted or dynamically truncated.

Only these reviewed application-data tables are truncated, with schema-qualified
identifiers: `comments`, `article_favorites`, `article_tags`, `articles`, `tags`,
`attachments`, `follows`, `users`. The `migrations` table is never truncated.

Cleanup uses one pinned QueryRunner connection. It records the original session
FK-check value, disables checks temporarily, truncates the allowlist, and restores
the original value in `finally`, even if DDL fails. It aggregates cleanup errors
instead of suppressing them. If FK restoration itself fails, it destroys the
physical connection rather than returning unknown FK state to the pool. No
transaction is used to pretend TRUNCATE can be rolled back.

Every `beforeEach` asserts that all application tables are empty and prior test
user IDs/revocation keys are absent, then persists actor, target and independent
user fixtures. Public values are deterministic; UUID-based identifiers prevent
collisions. The fixture helper optionally creates a real Follow and issues JWTs
through the configured JwtService with unique `pr6-c2:` JTIs and the configured
expiry. All generated revocation keys are tracked.

Every `afterEach` restores Jest mocks, attempts database and Redis cleanup, and
surfaces either or both failures. Redis cleanup permits only tracked
`auth:revoked:pr6-c2:` keys (using the application's revocation prefix); it never uses
FLUSHDB, wildcard deletion or deletion of unrelated test keys. Post-cleanup
assertions verify zero application rows, restored FK checks, unchanged migration
history and absent revocation keys. `afterAll` releases the lease/QueryRunner and
closes the real Nest application, including its MySQL pool and Redis client.

## Evidence and verification

The initial suite checks real public profile responses, authenticated Follow
creation and persisted direction, optional pre-existing Follow fixtures, logout
revocation, cleanup of a populated eight-table graph, unsafe configuration/live
schema rejection, account privilege isolation, concurrent lifecycle rejection
and FK restoration after the simulated infrastructure failure.

Fresh-start and post-cleanup assertions execute for every case, so a filtered
single case does not depend on ordering. Running the command twice demonstrates
cross-run cleanup as well as adjacent-case isolation:

```powershell
npm.cmd run test:c2
npm.cmd run test:c2
npm.cmd run test:c2 -- --testNamePattern="exact public profile"
npm.cmd run format
npm.cmd run lint
npm.cmd run build
npm.cmd test -- --runInBand --cacheDirectory=./node_modules/.cache/jest-pr6-unit
npm.cmd run test:e2e -- --runInBand --cacheDirectory=./node_modules/.cache/jest-pr6-e2e
git diff --check
```

SunLint 1.3.56 is required on all six new TypeScript files, including untracked
files. Use the existing official CLI with `--all --input=test`, and explicitly
scan each new file to confirm its inclusion. Subdirectory smart targeting of
`test/c2` can omit root-level files and is insufficient by itself. Its heuristic
results must be reviewed against fixed SQL identifier allowlists and explicit
negative fixtures; successful execution does not imply full TypeScript ESLint
analysis when that engine integration is unavailable.

The dedicated schema is disposable and C2 tests truncate all its application
data. Do not store manual fixtures there or bypass the lifecycle lease. The lease
protects cooperating C2 commands, not arbitrary administrator SQL. The complete
controller condition-coverage matrix and its coverage evidence remain Commit 2.
