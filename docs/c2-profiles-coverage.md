# ProfilesController C2 condition coverage

## Definition and scope

No more precise course/mentor definition was found in the repository. C2 here
means both outcomes of each feasible atomic boolean condition, each feasible
decision branch, and relevant compound-predicate combinations. HTTP results and
persisted state provide scenario evidence; Jest instrumentation provides separate
structural evidence. A percentage of Jest branches is not a C2 percentage.

The target is exactly ProfilesController: GET Profile, POST Follow, DELETE Follow.
The inventory includes ProfilesService, OptionalJwtAuthGuard, JwtStrategy and
Redis revocation verification on these request paths. CurrentUser projects the
request principal without a decision. JwtAuthGuard delegates to Passport; JWT
parsing/signature/expiry outcomes are behavioral boundary cases, not invented
application conditions. Startup configuration, token issuance, logout, unrelated
controllers and library-internal branch coverage are outside this assessment.

Implementation: [profiles-conditions.c2-e2e.ts](../test/c2/profiles-conditions.c2-e2e.ts).
The suite executes real HTTP, Nest middleware/guards/controller/service, TypeORM,
MySQL and Redis. No controller, service or repository is mocked. Infrastructure
fault injection is confined to the explicitly unavailable-dependency cases.

## Source condition matrix

The inventory was recorded before test implementation; the witnesses below now
refer to passing executions. `C-` identifies source conditions, distinct from test
IDs. T/F mean evaluated true/false; `-` means short-circuited. Each entry gives
source/function, both witnesses and observable evidence.

- **C-P01**: `profiles.controller.ts/getProfile`, principal presence in
  `principal?.user.id`: T G02, F G01. Both return 200; only the authenticated
  actor's stored relation produces `following=true`.
- **C-P02**: `profiles.service.ts/getProfile`, `currentUserId === undefined`:
  T G01 (200/false despite an existing relation), F G02/G03 (200/true or false
  according to the actual database relation).
- **C-P03**: `profiles.service.ts/findProfileUser`, `!user`:
  T G05/G06/F04/U03 (404, unchanged database), F G01/F01/U01 (200).
  Both lookup outcomes are exercised through all three service entry points.
- **C-P04**: `profiles.service.ts/follow`, `user.id === currentUserId`:
  T F02/F03 (400, no insert, including case-insensitive username lookup),
  F F01 (200, exactly one actor-target insert).
- **C-P05**: `profiles.service.ts/follow` catch,
  `error instanceof QueryFailedError`: T F05/F08/F10, F F09. F05 observes the real
  duplicate constraint (200, idempotent); F08 directly observes a nonduplicate
  QueryFailedError (500); F09 directly observes the connection-acquisition error
  class (500). All failed requests preserve persisted state.
- **C-P06**: same catch, `driverError.code === MYSQL_DUPLICATE_ENTRY_CODE`:
  T F05/F10 (200/500), F F08 (500 and observed nonduplicate driver code).
  Evaluated only when C-P05 is T.
- **C-P07**: exact relationship unique-index match: T F05 (idempotent 200),
  F F10 (different real unique index, sanitized 500). The temporary index is
  created and removed under the verified C2 lease. Real mysql2 errors supply
  `sqlMessage`; its nullish fallback is not fabricated with mocked SQL results.
- **C-G01**: `optional-jwt-auth.guard.ts/canActivate`,
  `authorization === undefined`: T G01/G08 (200 without Redis GET), F G02 and
  GET credential-negative cases (200 with valid credentials, otherwise 401/503).
- **C-J01**: `jwt.strategy.ts/validate`, `typeof sub !== 'string'`:
  T J01 (401 before Redis GET), F J02/J03/J04/F01.
- **C-J02**: same function, `typeof jti !== 'string'`:
  T J02 (401 before Redis GET), F J03/J04/F01.
- **C-J03**: same function, `!Number.isInteger(exp)`:
  T J03/J04 (401 before Redis GET), F F01 (200).
  The real configured JWT verifier independently accepts all four signed J-case
  tokens first, establishing that the application claim check rejects them.
- **C-J04**: same function, `await isTokenRevoked(jti)`:
  T all `A-*-revoked` cases (real Redis key, 401), F successful authenticated
  cases (200 and no revocation key).
- **C-J05**: same function, `!user` after subject lookup:
  T all `A-*-deleted-user` cases (401), F successful authenticated cases (200).
- **C-J06**: same function, `!token` after the second Bearer extraction:
  F authenticated successes; T **infeasible on the unmodified HTTP path**.
  Passport requires the same extractor to return a token before calling validate;
  nothing between the extractions mutates Authorization. No request/guard mock
  manufactures this outcome.
- **C-J07**: token version supplied: T normal tokens, F V01/V02.
- **C-J08**: version not a safe integer: T J06-J09, F F01/J05.
- **C-J09**: negative integer version: T J05, F F01.
- **C-J10**: persisted/token version mismatch: T V02/V03, F V01/V04.
  Deleted-user cases short-circuit the comparison. V01/V02 select the legacy
  nullish fallback; V03/V04 select the supplied version.
- **C-R01**: `redis.service.ts/assertReady`, `status !== 'ready'`:
  T all `A-*-redis-disconnected` cases (actual client end event, 503), F normal
  credentials and `A-*-redis-get-outage` cases (ready client).
- **C-R02**: `redis.service.ts/isTokenRevoked`, `value !== null`:
  T real revoked-token fixtures (401), F ordinary valid credentials (200).

Additional outcome/exception evidence, distinct from source boolean sites:

- **B01**: Follow existence returned by the real database: G02 true,
  G03/G04 false. GET preserves every snapshot.
- **B02**: scoped DELETE affects one row/no row: U01/U02. Both return 200/false;
  no relationship-existence `if` exists inside unfollow.
- **E01**: Redis GET succeeds/throws: successful authenticated cases versus
  `A-*-redis-get-outage`; the real RedisService catch produces sanitized 503.

HTTP outcomes and database/error observations are directly asserted. Mapping
those observations to source truth values uses the inspected control flow;
there is no custom runtime tracer for individual boolean values. Istanbul
statement/branch counters below provide independent structural evidence.

## Compound predicates and feasibility

- JWT claims use `C-J01 || C-J02 || C-J03`: supplied combinations TFF, FTF,
  FFT, FFF map to J01, J02, J03/J04, F01. Evaluated vectors are T--, FT-, FFT,
  FFF. Each isolated invalid claim changes the decision from the valid baseline.
- Follow catch uses `C-P05 && C-P06 && C-P07`: TTT is the real relationship
  duplicate, F05 -> idempotent 200; TTF is a different unique index, F10 -> 500;
  TF- is a closed MySQL request connection, F08 -> sanitized 500;
  F-- is failed connection acquisition, F09 -> sanitized 500. FT- is not an
  evaluated combination under short-circuit AND. F08 calls the real mysql2
  connection's destroy method immediately before the real INSERT; F09 injects
  acquisition unavailability. Neither fabricates a database result.
- Invalid signatures and expired tokens fail in Passport/JWT verification before
  JwtStrategy.validate. Missing protected-route credentials never reach the
  service. Anonymous GET skips JWT/Redis and supplies no viewer identity.
- Self-follow is rejected before INSERT. Missing profiles are rejected before
  self checks or writes. FK/unique constraints remain real. No bypassed guard or
  invalid database fixture is used to claim unreachable combinations.

Assessment: **19 feasible source condition sites have T/F witnesses**. C-J06 has
only its feasible F outcome. The nested version predicate is isolated with absent,
valid, noninteger and negative versions. This scoped assessment does not claim
universal 100% C2 or 100% Jest branch coverage.

## Compatibility and case catalogue

Merged main makes Follow idempotent and adds persisted token versions. F05 now
asserts 200, the exact successful body and unchanged state; F06 asserts [200, 200],
both exact bodies and one directed edge. F10 ensures other duplicate constraints
still propagate as sanitized 500 without mutation. Fixture JWTs sign the persisted
version, and snapshots hash that column along with private/public User columns.
Shared bootstrap uses `configureHttpApplication()`. No production code or migration
source was changed. `test:c2:setup` applied the pending `AddUserTokenVersion` migration.

There are **62 condition cases**:

- G01-G08: public profiles, authentication, relation direction, missing targets,
  null public fields and anonymous reads during Redis failure.
- F01-F10: insertion, self-follow, missing target, idempotent/concurrent duplicates,
  forged ownership, unavailable MySQL and a duplicate on another unique index.
- U01-U05: scoped, absent, repeated and forged-ownership deletion, preserving
  unrelated and reverse relationships.
- 26 authentication cases: missing/malformed/invalid credentials, wrong signature,
  expiry, revocation, deleted actor, Redis GET failure and disconnection.
- J01-J09: numeric sub/JTI, missing/fractional expiry, negative/fractional/string/
  unsafe/null versions; real signature verification accepts the token before
  strategy rejection, without a Redis GET or database mutation.
- V01-V04: legacy version-0 acceptance, legacy rejection at persisted version 1,
  stale current-token rejection and matching current-token acceptance.

Every response asserts its exact status and entire established English body.
Public fields are exactly username, bio, image and following. Snapshots hash
private/public User columns, compare ordered Follow rows and count every
discovered application base table. Existing state assertions remain intact.

## Shared lifecycle and independence

Both suites use [setupC2Suite](../test/c2/helpers/setup-c2-suite.ts) and the
[guarded lifecycle](c2-test-lifecycle.md). Fresh-state and post-cleanup assertions
run per case, including filtered cases. Teardown restores mocks and Redis outages
before independently attempting database and tracked-key cleanup. Failed/partial
initialization never dereferences missing or stale fixtures. Migration history,
FK state and absent tracked keys remain checked.

The infrastructure suite adds a real temporary future table/view to prove
rediscovery, counting, truncation, view exclusion and migration preservation.
Its populated-graph assertion permits additional empty application tables.
Helper unit regressions cover first/later initialization failures, cleanup and
shutdown aggregation, JWT/JTI tracking, invalid inventories and FK restoration
without services.

## Verification and structural coverage

Use Node.js **26.13.0**. Verify configuration and live schema/account before
destructive tests. C2 commands run serially under the exclusive schema lease.

```powershell
npm.cmd run test:c2:setup
npm.cmd run test:c2
npm.cmd run test:c2:coverage -- --json --outputFile=./node_modules/.cache/mentor-c2-coverage-results.json
npm.cmd run test:c2 -- --randomize --seed=41723 --showSeed
npm.cmd test -- --runInBand --cacheDirectory=./node_modules/.cache/jest-mentor-unit
npm.cmd run test:e2e -- --runInBand --cacheDirectory=./node_modules/.cache/jest-mentor-e2e
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/prettier/bin/prettier.cjs --check "src/**/*.ts" "test/**/*.ts"
npm.cmd run lint
npm.cmd run build
git diff --check
```

Generated evidence remains ignored under `coverage/c2-profiles/` and
`node_modules/.cache/mentor-*.json`. Coverage must be nonempty for all eight
configured source files. The old pre-merge 52-case figures are superseded;
current verification results accompany this changeset.

The current 62-case coverage run passed. Statements / branches / functions /
lines, in percent:

- ProfilesController: **100 / 75 / 100 / 100**.
- ProfilesService: **100 / 84 / 100 / 100**.
- Profile mapper, optional/required JWT guards and CurrentUser decorator:
  **100 / 100 / 100 / 100** each.
- JwtStrategy: **96 / 86.66 / 100 / 95.65**.
- RedisService: **70.37 / 50 / 85.71 / 68**.
- All eight files: **92.68 / 79.51 / 95.45 / 91.89** (114/123 statements,
  66/83 branches, 21/22 functions, 102/111 lines).

Generated decorator/type metadata branches, library internals and infeasible
C-J06 true are not claimed as covered. Redis token revocation belongs to logout
outside the controller condition suite. No ignore pragmas or production rewrites
hide these limits.

SunLint 1.3.56 supplements type-aware oxlint. Include new/untracked helper
regressions with `--all` and inspect its targeted-file list. Review findings
against guarded SQL identifiers and deliberately invalid JWT fixtures. Missing
TypeScript ESLint integration limits scanner analysis and must be reported
separately from successful heuristic scans.

## Latest verification results

All final checks below exited 0 on Node 26.13.0:

- Prettier check of all source/test TypeScript and the three changed Markdown
  files, type-aware oxlint, Nest build, full `tsc --noEmit --incremental false`,
  tracked diff whitespace and new-file whitespace checks.
- Unit tests with coverage: **590/590**, 28 suites, including **32** focused
  helper regressions. Command:
  `npm.cmd run test:cov -- --runInBand --cacheDirectory=./node_modules/.cache/jest-mentor-unit --coverageDirectory=./coverage/mentor-unit --json --outputFile=./node_modules/.cache/mentor-unit-final-results.json`.
- Normal E2E retry: **620/620**, 11 suites. Command:
  `npm.cmd run test:e2e -- --runInBand --cacheDirectory=./node_modules/.cache/jest-mentor-e2e --json --outputFile=./node_modules/.cache/mentor-e2e-retry-results.json`.
  The first run with output `mentor-e2e-results.json` exited 1: 619 passed and one
  registration case exceeded its existing 5-second timeout while other heavy
  checks ran. Running E2E alone passed with that original timeout unchanged.
- Final complete C2 suite: **73/73**, 2 suites (62 controller + 11 infrastructure).
  Command: `npm.cmd run test:c2 -- --randomize --seed=41723 --showSeed --json --outputFile=./node_modules/.cache/mentor-c2-final-results.json`.
- C2 coverage: **62/62**, eight nonempty source entries, measured above.
- Future-table/view regression independently: **1/1**, 10 skipped. Command:
  `npm.cmd run test:c2 -- --runTestsByPath test/c2/profiles-lifecycle.c2-e2e.ts --testNamePattern='discovers a future' --json --outputFile=./node_modules/.cache/mentor-c2-independent-results.json`.
- All three migration roundtrips: **1/1 each**, using the existing
  `test:migration:articles`, `test:migration:comments` and
  `test:migration:attachments` commands, each with its corresponding
  `-- --cacheDirectory=./node_modules/.cache/jest-mentor-migration-DOMAIN`.
  Each runner verified and removed its own disposable MySQL container.
- Final explicit SunLint scans: **8/8 files analyzed**, **0 errors, 43 warnings**.
  The three `.spec.ts` files used the inclusion config described in the lifecycle
  document. Warnings concern test literals, intentional generic failure fixtures,
  observer rethrows, validated identifier interpolation and configured JWT expiry;
  no confirmed correctness/security defect remains from this review. The earlier
  directory scan reported 0 errors and 258 warnings over 28 targeted files.
  Full TypeScript ESLint integration remains unavailable; type-aware oxlint passed.

A read-only postflight confirmed all eight current application tables empty,
all six migrations retained, the lease released, no temporary table/view/index,
and zero Redis keys matching the C2 namespace. No Redis wildcard deletion was
performed. The existing stopped MySQL test container was started for verification;
the token-version migration was applied only to the verified C2 schema.
