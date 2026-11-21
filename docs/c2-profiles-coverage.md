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
  `error instanceof QueryFailedError`: T F05/F08, F F09. F05 observes the real
  duplicate constraint (409); F08 directly observes a nonduplicate
  QueryFailedError (500); F09 directly observes the connection-acquisition error
  class (500). All failed requests preserve persisted state.
- **C-P06**: same catch, `driverError.code === MYSQL_DUPLICATE_ENTRY_CODE`:
  T F05 (409), F F08 (500 and observed nonduplicate driver code).
  Evaluated only when C-P05 is T.
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
- Follow catch uses `C-P05 && C-P06`: TT is a real duplicate constraint,
  F05 -> 409; TF is a closed MySQL request connection, F08 -> sanitized 500;
  F- is failed connection acquisition, F09 -> sanitized 500. FT is not an
  evaluated combination under short-circuit AND. F08 calls the real mysql2
  connection's destroy method immediately before the real INSERT; F09 injects
  acquisition unavailability. Neither fabricates a database result.
- Invalid signatures and expired tokens fail in Passport/JWT verification before
  JwtStrategy.validate. Missing protected-route credentials never reach the
  service. Anonymous GET skips JWT/Redis and supplies no viewer identity.
- Self-follow is rejected before INSERT. Missing profiles are rejected before
  self checks or writes. FK/unique constraints remain real. No bypassed guard or
  invalid database fixture is used to claim unreachable combinations.

Assessment: **14 feasible source condition sites have T/F witnesses**, and all
their feasible decision outcomes are covered. The fifteenth site, C-J06, has only
its feasible F outcome. B01/B02 and E01 are also exercised. This is a scoped
condition/decision assessment, not universal 100% C2 or 100% Jest branch coverage.

## Passing test catalogue and assertions

There are **52 new cases**: G01-G08 (8), F01-F09 (9), U01-U05 (5),
26 authentication cases and J01-J04 (4).

- **G01** anonymous existing profile, 200/false even with a stored relation.
- **G02** authenticated actor follows target, 200/true.
- **G03** authenticated actor does not follow target, 200/false.
- **G04** reverse/unrelated edges only, 200/false.
- **G05/G06** anonymous/authenticated unknown target, 404.
- **G07** null bio/image, 200 with nulls preserved; other G cases cover non-null.
- **G08** anonymous request during Redis GET outage, 200/false, GET spy uncalled.
- **F01** new follow, 200/true; exactly one new actor-target row, pre-existing
  reverse edge unchanged and no extra reverse edge.
- **F02/F03** self-follow by exact/uppercase username, 400 and no insert.
- **F04** missing target, 404 and no insert.
- **F05** real duplicate constraint, 409 with exactly one existing relation.
- **F06** two concurrent HTTP POSTs, statuses exactly [200, 409], exact bodies,
  exactly one persisted actor-target edge.
- **F07** forged body/query identity, 200; only JWT actor/path target inserted.
- **F08/F09** unavailable MySQL query/acquisition, exact sanitized 500 and
  unchanged persisted state; original exception types are observed and rethrown.
- **U01** existing relation, 200/false; only actor-target removed.
- **U02** absent relation, 200/false; entire snapshot unchanged.
- **U03** missing target, 404; entire snapshot unchanged.
- **U04** repeated DELETE, both 200/false; first removes only actor-target,
  second leaves the entire resulting snapshot unchanged.
- **U05** forged body/query identity, 200/false; unrelated relationships retained.
- **Authentication IDs** are `A-{GET|POST|DELETE}-{kind}`. Each method exercises
  `malformed`, `invalid`, `wrong-signature`, `expired`, `revoked`, `deleted-user`,
  `redis-get-outage`, and `redis-disconnected`. POST/DELETE additionally exercise
  `missing`; anonymous GET is G01. All are 401 except the two Redis-unavailable
  kinds, which are 503. All preserve the database snapshot taken after fixture
  preconditions, including intentional actor deletion for `deleted-user`.
- **J01/J02/J03/J04** signed numeric sub, numeric jti, missing exp, fractional
  exp respectively; all 401 before Redis GET and without database mutation.

Every request asserts exact status and entire response body. Successful bodies
contain exactly `{ profile: { username, bio, image, following } }`, preventing
email, passwordHash, IDs and timestamps from silently leaking. Error bodies
assert the established English message and Nest status/error shape, including
the default sanitized 500 and Redis fail-closed 503.

Snapshots hash all selected User columns (including private fields) to verify
unchanged users without printing private values on failure, compare complete
ordered Follow rows and count all eight application tables. Mutations compare
the exact expected Follow difference, unchanged users and unrelated table counts.

## Lifecycle and independence evidence

Commit 1 provisioning, migrations, fixtures, schema/account checks, pinned cleanup
connection and advisory lease are reused unchanged. All C2 destructive operations
remain restricted to `nestjs_tutorial_c2_test` on `127.0.0.1:3308` using its
schema-specific account. No provisioning rerun or migration edit was needed.

Before every new case, all eight tables must be empty, prior fixture UUIDs and
tracked Redis keys must be absent, and three fresh users plus a real signed JWT
are created. Scenario-specific relations are inserted afterward. No increasing
ID assumption is used.

After every case, spies are restored, any disconnected Redis client is
reconnected after its actual end event, tracked keys are deleted and the existing
guarded TRUNCATE cleans exactly the eight allowlisted tables. Teardown asserts
zero rows, pinned-session FK checks restored to 1, identical migration history
and absent tracked keys. No global Redis flush or transaction rollback is used.
Errors are aggregated while database/client shutdown still runs. The dedicated
lease and serial Jest runner are preserved; C2 commands were never concurrent.

Fresh verification on Node **26.13.0**:

- Full dedicated suite: **62/62**, two suites (10 existing infrastructure + 52 new).
- Focused profile suite with coverage: **52/52**, one suite.
- Full deterministic shuffled runs: seeds **41723** and **92811**, **62/62** each.
- G02, F08, F09, U01 and J04 each passed alone in a separate Jest process
  (one executed case per command, 51 skipped), proving normal, database-failure,
  deletion and invalid-claim cases do not require earlier cases.
- Deliberate failed-assertion probe: a temporary copy changed G01's expected 200
  to 418. Jest exited **1**, with exactly that one assertion failure and no hook
  failure. A subsequent read-only verification exited **0**: all eight tables
  were empty and all five migrations remained. Original teardown also verified
  Redis keys, FK checks and migration identity. The temporary test was removed.

## Measured structural coverage

Collected using only the 52 new profile cases with `npm.cmd run test:c2:coverage`.
The dedicated config uses repository root paths so production files are actually
instrumented, while discovery still includes only `test/c2/**/*.c2-e2e.ts`.
Generated reports remain ignored under `coverage/c2-profiles/`.

Values below are **statements / branches / functions / lines**, percentages:

- ProfilesController: **100 / 75 / 100 / 100**.
- ProfilesService: **100 / 86.36 / 100 / 100**.
- Shared profile mapper: **100 / 100 / 100 / 100**.
- OptionalJwtAuthGuard: **100 / 100 / 100 / 100**.
- JwtAuthGuard: **100 / 100 / 100 / 100** (no own instrumented branches/functions).
- CurrentUser decorator: **100 / 100 / 100 / 100** (no own branches).
- JwtStrategy: **96 / 82.6 / 100 / 95.65**.
- RedisService: **70.37 / 50 / 85.71 / 68**.
- All eight selected files: **92.68 / 78.08 / 95.45 / 91.89**
  (114/123 statements, 57/73 branches, 21/22 functions, 102/111 lines).

The missing JwtStrategy statement at line 57 is infeasible C-J06 T. Uncovered
controller/service constructor and decorated-parameter `cond-expr` counters are
generated TypeScript decorator/type-metadata checks, mapped to declarations rather
than additional source decisions. Corresponding strategy/Redis injection metadata
fallback counters are also not request business decisions. RedisService lines
38-55 belong to `revokeToken`, a logout/issuance path outside this controller;
that function and its conditions are deliberately not exercised here. No ignore
pragmas, fabricated principals or production rewrites hide these limitations.

## SunLint and regression gates

SunLint **1.3.56** ran through its supported cached CLI with relative input paths
and `--all` so the untracked new test was included:

```powershell
$sunlintCli = 'D:\nestjs-npm-cache\_npx\d135427ecc649769\node_modules\@sun-asterisk\sunlint\cli.js'
node $sunlintCli --all --input=test/c2/profiles-conditions.c2-e2e.ts --format=json --output=node_modules/.cache/pr6-commit2/sunlint-changed.json --output-summary=node_modules/.cache/pr6-commit2/sunlint-changed-summary.json
node $sunlintCli --all --input=test --format=json --output=node_modules/.cache/pr6-commit2/sunlint-test.json --output-summary=node_modules/.cache/pr6-commit2/sunlint-test-summary.json
```

- Changed TypeScript: **1 file, 0 errors, 18 warnings**, exit **0**.
- Full test scan: **19 files, 0 errors, 198 warnings**, exit **0**.
- Multiset comparison by normalized path/rule/severity/message against Commit 1:
  **180 retained pre-existing warnings, 18 new, 0 removed**.
- New C018 x4 and C030 x1 at line 468: false positives on an infrastructure
  observer catch/rethrow. Preserving the original error is necessary to test the
  real handler; this is not missing application error logging.
- New S006 x1 at line 608: false positive. The Authorization template contains
  the generated negative-test JWT, not the random signing secret passed to the
  signer. It is sent only to the local test app and never logged.
- New C024 x12: nonblocking style heuristics on readable test names and protocol
  literals; no confirmed security or correctness defect. No unrelated refactor
  or warning suppression was added.
- **Full TypeScript ESLint analysis: NOT VERIFIED.** The CLI reports missing
  `@typescript-eslint` parser/plugin and an ESLint config. Its 65 heuristic rules
  plus limited one-rule ESLint engine ran; no dependencies/config were added just
  for this scanner. The project's separate type-aware oxlint gate passed.

All commands use Node 26.13.0 and writable caches. Final command results:

- `npm.cmd run test:c2`: exit **0**, 62 passed.
- `npm.cmd run test:c2:coverage -- --json --outputFile=./node_modules/.cache/pr6-commit2/coverage-tests.json`:
  exit **0**, 52 passed and nonempty coverage for eight files.
- `npm.cmd run test:c2 -- --randomize --seed=41723 --showSeed`: exit **0**, 62 passed.
- Same command with `--seed=92811`: exit **0**, 62 passed.
- `npm.cmd run test:c2 -- --runTestsByPath test/c2/profiles-conditions.c2-e2e.ts --testNamePattern='\[ID\]'`:
  exit **0** separately for G02, F08, F09, U01 and J04; one passed each.
- `npm.cmd test -- --runInBand --cacheDirectory=./node_modules/.cache/jest-pr6-unit`:
  exit **0**, **367/367**, 21 suites.
- `npm.cmd run test:e2e -- --runInBand --cacheDirectory=./node_modules/.cache/jest-pr6-e2e`:
  exit **0**, **567/567**, 11 suites; normal tests retain their existing separate
  regression database and exclude C2. New C2 code never accesses that schema.
- `npm.cmd run format`, `npm.cmd run lint`, `npm.cmd run build`: exit **0** each.
  The formatter's unrelated historical comment-test change was restored.
- SunLint changed/full commands above: exit **0** each.
- `git diff --check`: exit **0**. Focused Prettier check of all four changed/new
  files: exit **0**. Additional `git diff --no-index --check -- /dev/null FILE`
  checks for both new files emitted no whitespace diagnostics and exited **1**
  because each file differs from the empty input (expected no-index difference).

An earlier implementation run exited 1 because Redis disconnection is
asynchronous; awaiting the real end event fixed it. An initial coverage command
exited 0 but collected an empty report because source globs were outside Jest's
root; that result was rejected, the dedicated root/globs were corrected and the
full 52-case measured run above supersedes it. No `--forceExit` was used.

Ignored local evidence lives in `node_modules/.cache/pr6-commit2/`: JSON test
results, gate logs, `failure-cleanup-evidence.json`, `sunlint-comparison.json` and
scanner reports. Instrumented details are in
`coverage/c2-profiles/{coverage-final.json,coverage-summary.json,lcov.info}` and
the HTML report. These generated files are not part of the change.

## Scope and remaining limitations

Changed files are the new profile condition suite and this document, dedicated
Jest configuration and the package coverage command. Production logic, the shared
mapper/cache policies, Commit 1 lifecycle helpers, dependencies/lockfile and
migrations remain unchanged. No confirmed unresolved security/correctness defect
was found in this scoped work. C-J06 T, generated metadata branches, out-of-scope
Redis token revocation and unavailable full TypeScript ESLint are the stated
limits; this report does not claim a whole-application security audit.

Changes remain unstaged and uncommitted on `feat/e2e-c2-testing`. No branch switch,
push, PR or Commit 3 work was performed.

Suggested commit: `test(e2e): add C2 coverage for profiles controller`.
