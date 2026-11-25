# Isolated Profiles C2 suite lifecycle

Both profile C2 suites use `setupC2Suite()` from
`test/c2/helpers/setup-c2-suite.ts`. It registers the four Jest lifecycle hooks
once per suite and exposes the current application, fixtures and infrastructure.
The condition matrix is documented in [c2-profiles-coverage.md](c2-profiles-coverage.md).
No production business logic, dependency or migration source is changed.

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
and applies all current TypeORM migrations, including `AddUserTokenVersion`.
Rerun it after merging migrations from `main`; it applied that pending migration
to the existing C2 schema during this review. Underscores in the database
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

The helper initializes the real AppModule and uses `configureHttpApplication()`
for the global `/api` prefix and current body parsers. Supertest requests execute
real guards, ProfilesController,
ProfilesService, TypeORM, MySQL and Redis. No controller, service, repository or
successful database response is mocked. One explicitly named infrastructure
failure test rejects a TRUNCATE call to verify FK restoration; its session reads,
FK changes and subsequent cleanup still run against MySQL.

## Lifecycle and safety

`C2DatabaseLifecycle.start()` validates MySQL and Redis, verifies the live schema,
acquires a connection-owned MySQL named lease, discovers and validates the current
base tables, checks applied migrations, and cleans the dedicated schema. A second
C2 process
fails immediately while that lease is held. Provisioning uses the same lease.
The lease lasts through the suite and is released before application shutdown.

Immediately before **every TRUNCATE**, the helper verifies:

- `NODE_ENV=test` and MySQL engine.
- Exact approved host, port, schema and account.
- `synchronize=false`, `migrationsRun=false`, and no schema-drop option.
- No alternate URL, replica, socket or driver-extra connection override.
- The pinned physical connection's `DATABASE()` is the exact C2 schema.
- `CURRENT_USER()` identifies the dedicated `nestjs_c2_test` account.
- That connection still owns the C2 lease and has no active transaction.

The dedicated account cannot select the existing shared E2E schema. The guard
does not accept an arbitrary name ending in `_test`.

Counting and truncation rediscover tables from `information_schema.tables` using
a bound exact schema name and `TABLE_TYPE = 'BASE TABLE'`. Views are excluded.
The inventory must contain `migrations` and at least one application table, with
no duplicates or malformed entries. Every name must match
`[A-Za-z_][A-Za-z0-9_]{0,63}` before it can appear in SQL. Identifiers are then
backtick-quoted and schema-qualified. Unusual identifiers outside this convention
fail closed; they are never silently skipped. The `migrations` table is filtered
out of both counts and truncation, and a custom migration ledger is refused.
Future migrations adding conventional table names need no cleanup-list update.

Cleanup uses one pinned QueryRunner connection. It records the original session
FK-check value, disables checks temporarily, truncates the discovered tables, and
restores
the original value in `finally`, even if DDL fails. It aggregates cleanup errors
instead of suppressing them. If FK restoration itself fails, it destroys the
physical connection rather than returning unknown FK state to the pool. No
transaction is used to pretend TRUNCATE can be rolled back.

Every `beforeEach` asserts that all application tables are empty and prior test
user IDs/revocation keys are absent, then persists actor, target and independent
user fixtures. Public values are deterministic; UUID-based identifiers prevent
collisions. The fixture helper optionally creates a real Follow and issues JWTs
through `issueC2Token()` with unique `pr6-c2:` JTIs, the persisted token version,
and the configured expiry. The same issuer accepts signing options and explicit
claim overrides for negative cases; there is no separate `trackJti`. It tracks
the final string JTI before signing, including when signing fails. Invalid
nonstrings cannot identify Redis keys. Non-C2 string JTIs are refused.

Before any per-case assertion or fixture write, the helper clears the previous
fixture reference. If initialization fails after partial writes or signing,
teardown does not dereference missing/stale fixtures: it still cleans every
discovered table and all tracked keys. An incomplete database preflight never
enables destructive per-case cleanup.

Every `afterEach` restores Jest mocks and simulated infrastructure outages, then
attempts database and Redis cleanup and surfaces either or both failures. Redis
cleanup permits only tracked
`auth:revoked:pr6-c2:` keys (using the application's revocation prefix); it never uses
FLUSHDB, wildcard deletion or deletion of unrelated test keys. Post-cleanup
assertions verify zero application rows, restored FK checks, unchanged migration
history and absent revocation keys. `afterAll` releases the lease/QueryRunner and
closes the real Nest application, including its MySQL pool and Redis client.
If HTTP application creation failed after module compilation, it closes the
compiled module instead. Cleanup and shutdown errors are aggregated, so all
independent cleanup attempts run and real failures remain visible.

## Evidence and verification

The initial suite checks real public profile responses, authenticated Follow
creation and persisted direction, optional pre-existing Follow fixtures, logout
revocation, cleanup of a populated application graph, unsafe configuration/live
schema rejection, account privilege isolation, concurrent lifecycle rejection
and FK restoration after the simulated infrastructure failure. A temporary future
table/view test proves discovery, counting, truncation, view exclusion and
migration preservation against MySQL. Its DDL uses the same verified C2 lease.

Focused unit tests in `test/c2/helpers/*.spec.ts` require no infrastructure. They
cover failed first/later fixture initialization, restoration ordering, multiple
cleanup/shutdown failures, token/JTI tracking, malformed/empty table discovery,
live schema/account/lease rejection, and both original FK-check states. They run
under the normal unit command, not the destructive C2 Jest configuration.

Fresh-start and post-cleanup assertions execute for every case, so a filtered
single case does not depend on ordering. Running the command twice demonstrates
cross-run cleanup as well as adjacent-case isolation:

```powershell
npm.cmd run test:c2
npm.cmd run test:c2
npm.cmd run test:c2 -- --testNamePattern="exact public profile"
node node_modules/prettier/bin/prettier.cjs --check "src/**/*.ts" "test/**/*.ts"
npm.cmd run lint
npm.cmd run build
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm.cmd test -- --runInBand --cacheDirectory=./node_modules/.cache/jest-pr6-unit
npm.cmd run test:e2e -- --runInBand --cacheDirectory=./node_modules/.cache/jest-pr6-e2e
git diff --check
```

SunLint 1.3.56 is required on all changed/new TypeScript files, including untracked
files. Use the existing official CLI with `--all --input=test`, and explicitly
scan each new file to confirm its inclusion. Subdirectory smart targeting of
`test/c2` can omit root-level files and is insufficient by itself. Its heuristic
results must be reviewed against SQL identifier validation and explicit
negative fixtures; successful execution does not imply full TypeScript ESLint
analysis when that engine integration is unavailable.

The CLI excludes `*.spec.ts` by default, even for explicit file input, and can
exit 0 without analyzing a file. For the three new helper regression files, use
a local ignored config containing `{"languages":["typescript"],"includeTests":true}`
and pass `--config=node_modules/.cache/mentor-sunlint-config.json`. Verify each
summary reports `files_analyzed: 1`. This changes targeting only; no rule is disabled.

The dedicated schema is disposable and C2 tests truncate all its application
data. Do not store manual fixtures there or bypass the lifecycle lease. The lease
protects cooperating C2 commands, not arbitrary administrator SQL. The complete
controller condition-coverage matrix and current evidence are in the companion
document.
