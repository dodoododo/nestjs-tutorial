# PR5 Comment APIs: Commits 2–5

Commit 2 implements `POST /api/articles/:slug/comments`. Commit 3 adds
`GET /api/articles/:slug/comments` with optional authentication and shared public
profile mapping. Commit 4 adds author-only Comment deletion.
The nested request and Single Comment response follow the
[RealWorld Add Comment contract](https://realworld-docs.netlify.app/specifications/backend/endpoints/#add-comments-to-an-article).
Update Comment, replies, likes and pagination are not implemented.

## Request and project conventions

Authentication is required through the existing `JwtAuthGuard`:

```http
POST /api/articles/current-article-slug/comments
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "comment": {
    "body": "  This article is helpful!\n\nThank you 😀  "
  }
}
```

The project uses Bearer authentication, consistent with PR2–PR4, rather than
RealWorld's Token header examples. Successful creation returns **HTTP 201
Created**, an explicit project convention matching Create Article. Invalid input
returns the existing Nest ValidationPipe HTTP 400 error format, rather than
RealWorld's 422 error format. Comment public IDs are UUID strings, consistent
with the database foundation, rather than the numeric IDs in example responses.

`CreateCommentRequestDto` requires a nested, non-null object named `comment`.
Its `body` must be a nonblank string. Missing/null values, arrays, primitive
wrappers and unknown top-level or nested fields return 400. Client-supplied
`id`, `commentId`, `authorId`, `articleId`, author objects, timestamps and other
ownership fields are rejected. No ownership values are copied into persistence.

Body formatting is preserved exactly, including meaningful line breaks and
leading/trailing whitespace. Nonblank validation does not trim the stored text.
Unpaired UTF-16 surrogates are rejected as invalid Unicode; valid supplementary
characters such as emoji are accepted. `COMMENT_BODY_MAX_BYTES` is **65,535**,
matching MySQL TEXT. Validation uses `Buffer.byteLength(body, 'utf8')` before
persistence, including whitespace. Multibyte text at that byte boundary succeeds;
larger input returns 400. Character-count validation cannot replace this check.
These are the same body-validation principles already used by Create/Update
Article; those DTOs remain unchanged.

The final review corrected a transport boundary: JSON escaping can make valid
65,535-byte text exceed Express's default 100 KB JSON limit. Before application
initialization, `configureHttpApplication` sets the global prefix and calls
`setupCommentBodyParser` with that same prefix. The parser uses native Express
POST route matching and `COMMENT_COLLECTION_PATH`, the same constant used by
`CommentsController`; no prefix or controller route regex is duplicated.
It registers a 400 KiB JSON parser only for POST Comments, followed by the default
parser for other JSON requests. This
allows even six-byte JSON escapes at the TEXT boundary; the DTO still enforces
65,535 decoded UTF-8 bytes. Requests exceeding the transport cap return 413.
Other routes and methods retain their existing transport limits. HTTP tests
verify escaped line breaks, quotes, control characters, decoded-byte rejection,
malformed JSON, Content-Type variations and the unchanged limits outside POST
Comments. The same production bootstrap helper is exercised with `api`, `v2/api`
and no global prefix, including maximum-size escaped and multibyte bodies.

A global 400 KiB limit would increase parsing work and memory use for every
JSON endpoint, including unauthenticated requests. The route-scoped parser keeps
that increase confined to Comment creation. A Nest module middleware would run
after the default parser and require disabling and replacing the defaults; the
bootstrap registration preserves Nest's automatic URL-encoded parser instead.
See the [Nest middleware guidance](https://docs.nestjs.com/middleware) and
[Express body-parser options/errors](https://expressjs.com/en/resources/middleware/body-parser/).

## Persistence and response

The service looks up the Article by its current slug and selects its stable UUID.
Unknown slugs return a Comment-domain 404 before any write. Any authenticated user
can comment, including the Article's owner. Article authorship is independent of
Comment authorship, which comes only from `principal.user.id`.

The controller passes the complete `principal.user` already loaded and validated
by `JwtStrategy`. The service uses that user's ID and public profile fields
without another User query, then saves an explicit allowlist of `articleId`,
`authorId` and `body`. TypeORM generates the
UUID, performs one atomic INSERT and reloads the database-generated millisecond
timestamps. `transaction: false` avoids a transaction around this single write.
The Article content, timestamps and relationship storage are untouched. Multiple
comments from the same author on the same Article are allowed. No schema or
migration changes are needed; `synchronize` and `migrationsRun` remain false.

The response is:

```json
{
  "comment": {
    "id": "00000000-0000-4000-8000-000000000001",
    "createdAt": "2026-01-01T00:00:00.123Z",
    "updatedAt": "2026-01-01T00:00:00.123Z",
    "body": "  This article is helpful!\n\nThank you 😀  ",
    "author": {
      "username": "jacob",
      "bio": null,
      "image": null,
      "following": false
    }
  }
}
```

`CommentResponseDto` and `CommentDto` document an explicit public allowlist and
reuse the existing `ProfileDto`. The pure `mapComment` function receives a Comment,
public author fields and viewer-specific `{ following }` metadata; it neither
queries the database nor mutates inputs. Internal Article/User UUIDs, entity
relations, email, password hashes and tokens are excluded. Dates use the same
`toISOString()` format as Articles. For creation the viewer is the Comment author;
self-follow is prohibited, so the service supplies false without a following
query. The mapper also supports true metadata for later collection responses.
Both Comment and Article mappers now call `mapProfile`, a small pure mapper under
`src/profiles/mappers/`. Its typed input contains only `username`, `bio` and
`image`; following is supplied separately. It returns an explicit public
allowlist and does not query repositories. ProfilesService also uses it for
Get Profile, Follow and Unfollow responses. Existing Article correlated SQL and
Profile/Follow queries remain unchanged; their distinct query strategies stay
in the service layer. Regression tests cover both following values, populated
and nullable profiles, private-field exclusion and unchanged response shapes.

## Get Comments

Listing follows the
[RealWorld Get Comments contract](https://realworld-docs.netlify.app/specifications/backend/endpoints/#get-comments-from-an-article).

```http
GET /api/articles/current-article-slug/comments
Authorization: Bearer <optional JWT>
```

An existing Article returns HTTP 200 with `{ "comments": [...] }`. Existing
Articles without Comments return `{ "comments": [] }`; unknown slugs return 404
using the existing Comments-domain localized Article-not-found message. There is
no `commentsCount`. Every item reuses `CommentDto` and the same `mapComment`
function used by POST, including UUID identity, exact body text, ISO timestamps
and the public author profile.

`OptionalJwtAuthGuard` permits anonymous access only when Authorization is absent.
Supplied malformed headers, invalid/expired/incorrectly signed/revoked tokens,
and tokens for deleted users return 401. Redis failure returns 503 for supplied
valid credentials; anonymous reads bypass JWT/Redis checks. The viewer comes
only from the authenticated principal. Query parameters cannot select an Article
UUID or impersonate a viewer: unsupported identity parameters are ignored, as
with the existing single-Article route. No filtering or pagination parameters
are implemented or documented.

GET Comments sends `Cache-Control: private, no-store` for both anonymous and
authenticated successful responses, including empty lists. `author.following`
depends on the viewer, so the response must not be stored for later reuse across
requests or identities. The header is scoped to this GET handler; there is no
global API cache policy. E2E coverage checks the actual HTTP header for anonymous,
following and non-following viewers requesting the same Article, and for empty
lists. This uses the established Nest `@Header` convention without changing
service queries or other endpoints.

The retrieval path uses a fixed number of SQL statements:

1. Resolve the current Article slug, selecting only its UUID.
2. Fetch matching Comments through a single inner join to User, selecting
   Comment ID/body/timestamps and author ID/username/bio/image. Scope by
   `comments.article_id` with a bound parameter and order in SQL by
   `created_at DESC, id DESC`. The existing `(article_id, created_at, id)` index
   supports this ordering; UUID ties are stable across reads. No Article body or
   author email/password hash/role is selected by these service queries.
3. For authenticated viewers with a nonempty list, deduplicate author IDs and
   run one parameterized `Follow` lookup using `followerId = viewerId` and
   `followingId IN (...)`. Select only following IDs (TypeORM may also select the
   Follow primary key for hydration). Build a Set for pure response mapping.
   Anonymous and empty lists skip this query.

Thus the service uses **2 statements anonymously**, **3 for authenticated
nonempty results**, and **2 for authenticated empty results**. The existing JWT
strategy adds **1 User lookup** to authenticated HTTP requests, so actual HTTP
totals are 2, 4 and 3 respectively. An unknown Article stops after the first
service lookup. Redis commands are separate from SQL. Author hydration occurs
in the Comment join; there are no per-Comment or per-author SQL queries. The
anonymous mapper receives following=false; authenticated results reflect stored
Follow direction, including multiple followed authors and subsequent unfollows.
The batch is bounded to distinct authors in this Article's returned Comments.

Get Comments matches the current RealWorld contract without pagination. Large
Articles therefore have unbounded response/memory costs; the single Follow IN
lookup also grows with distinct author count. Fixed SQL statement count does not
bound result size. Article lookup, Comment retrieval and Follow metadata are
separate reads, so concurrent deletions or relationship changes may become visible
between them; no snapshot transaction or pessimistic lock is introduced.

Unexpected retrieval failures return a sanitized 500 using
`comments.RETRIEVAL_FAILED` (English/Vietnamese). Creation and retrieval share a
small existing-style private error handler: safe Logger metadata, original cause
attached server-side, and no raw SQL/request contents in logs or responses.
Expected 404s are preserved without unexpected-error logging.

## Delete Comment

`DELETE /api/articles/:slug/comments/:id` requires the existing Bearer JWT guard.
The successful response is **204 No Content**, with an empty body, matching the
project's Delete Article convention. No exact deletion status is mandated by the
[RealWorld Delete Comment contract](https://realworld-docs.netlify.app/specifications/backend/endpoints/#delete-comment).

`ParseUUIDPipe` validates the Comment ID before the handler runs. Malformed IDs
return 400; valid unmatched UUIDs return 404. Guards run first, so missing or
invalid credentials return 401 even with malformed path input. Redis revocation
failure remains fail-closed with 503 before the deletion service executes.

The service resolves the current Article slug and selects only its UUID, then
finds the Comment by **both ID and Article UUID**, selecting only Comment ID and
author ID. Unknown Articles or Comments, including IDs from another Article,
return 404. Membership is checked before ownership, so even the actual author
gets 404 for an ID under another Article's slug. A different Comment author gets
403; Article ownership grants no exception. The only ownership identity is
`principal.user.id`. Body/query fields have no effect, following the existing
Delete Article convention; they cannot select a different target or impersonate
an author.

After the explicit authorship check, one parameterized TypeORM DELETE is scoped
by Comment ID, Article ID and principal author ID. Only `affected === 1` succeeds.
Zero affected rows return 404, including a concurrent deletion after lookup.
Repeated deletion also returns 404. Concurrent requests are not serialized; one
successful deletion and one 404 are expected. No transaction, pessimistic lock,
Article lock, retry framework or distributed lock is needed for one atomic
DELETE of an immutable-author Comment. Only the intended Comment is removed;
Article content/timestamps/tags/favorites, Users, Follows and other Comments stay
intact. Existing schema, foreign keys and migrations are unchanged.

The concurrent DELETE HTTP test gates both successful Comment lookups before
either deletion can proceed. It releases one request, observes its scoped DELETE
affect one row, then releases the second and observes zero affected rows. The
responses must be exactly 204 and 404, with unrelated Comments and Articles
unchanged. Synchronization waits and HTTP requests have deadlines; `finally`
releases every gate, drains requests and restores the persistence spies.

Expected 403/404 errors are preserved without unexpected-error logging.
Unexpected lookup/DELETE errors use the existing safe Logger metadata and
server-side original cause, with a sanitized Comments-domain 500 response.
English and Vietnamese messages cover Comment-not-found, not-author and deletion
failure. Swagger documents slug/UUID parameters, required authentication and
204/400/401/403/404/500/503 responses, with no content schema for 204.
GET Comments retains `Cache-Control: private, no-store` and its existing batching.

## Authentication, races and errors

- Missing, invalid, expired, incorrectly signed, revoked or deleted-user JWTs
  return 401 through the existing authentication implementation.
- Redis revocation-check unavailability remains fail-closed with 503.
- A missing author during the existing JWT lookup returns 401 before the Comment
  service runs. There is no second User lookup. An author deletion after
  authentication can cause an author foreign-key
  failure; it is sanitized and logged as 500, never mislabeled as Article 404.
- If insertion fails with `ER_NO_REFERENCED_ROW_2` specifically naming
  `FK_comments_article_id`, that exact constraint failure directly becomes the
  existing localized Article 404 without another existence query. Author foreign
  keys, lookalike constraint names, other driver codes and non-database failures
  retain the sanitized/logged 500 behavior. Existing foreign keys prevent orphan comments without pessimistic
  locks or application cleanup.
- Unexpected lookup/persistence failures return a Comment-domain 500. Nest Logger
  records the operation, error category and validated driver code, without raw
  SQL, query parameters, request content, tokens or untrusted driver messages.
  The original error remains attached as the exception's server-side cause;
  clients receive no SQL details, stack traces or filesystem paths.

`comments.json` provides English and Vietnamese Article-not-found, creation and
retrieval failure messages. Existing language resolvers support `?lang=vi`, `x-lang` and
Accept-Language. Validation and authentication retain their established error
messages and status conventions. Swagger at `/docs` (`/docs-json`) documents the
POST operation, nested body, Bearer auth, slug, public response and
201/400/401/404/413/500/503 statuses. GET documents optional authentication, the slug,
ordering, no pagination, shared Multiple Comments response and
200/401/404/500/503 statuses. DELETE documents the author-only behavior above.

## Verification and limits

Run with Node.js 26.13.0 against the migrated isolated test services:

```powershell
npm.cmd test -- --runInBand src/comments
npm.cmd run test:e2e -- --runInBand comments.e2e-spec.ts --cacheDirectory=./node_modules/.cache/jest-pr5
npm.cmd exec -- tsc --noEmit -p tsconfig.json
npm.cmd exec -- tsc --noEmit -p tsconfig.build.json
npm.cmd run test:migration:articles
npm.cmd run test:migration:comments
npm.cmd run test:migration:attachments
npm.cmd run lint
npm.cmd run build
npm.cmd test -- --runInBand
npm.cmd run test:e2e -- --runInBand --cacheDirectory=./node_modules/.cache/jest-pr5
git diff --check
```

Comment unit tests cover service identity/lookup/persistence, explicit unknown
Article 404s, foreign-key race classification, sanitized errors, DTO boundaries
and malformed input, and pure allowlisted mapping with both following values.
API E2E tests use MySQL at `127.0.0.1:3308/nestjs_tutorial_test` and Redis at
`127.0.0.1:6380`, with isolation checked before fixture writes. They cover real
persistence and timestamps, unchanged Articles and existing comments, own-Article
and repeated comments, current-slug lookup, input boundaries, authentication,
Redis failure, translated errors, a real Article-deletion foreign-key race and
Swagger. Cleanup targets only test-created users/records and revocation keys.
Run ordinary E2E suites serially for shared fixture isolation. They require an
already migrated schema and never revert historical migrations or drop tables.
Destructive roundtrips run in separate disposable MySQL containers through the
three dedicated commands; see [database reproduction and safety](comment-database.md#reproduce-from-a-fresh-checkout).
No development or production database is used.

Commit 4 adds service and HTTP tests for author-only deletion, cross-Article 404s
before ownership checks, invalid UUIDs, current-slug lookup, repeated deletion,
zero affected rows, concurrent requests, auth/Redis failures, ignored forged
ownership fields, localized/sanitized errors and preservation of related data.

### SunLint quality gate (Commit 4)

SunLint **1.3.56** is run through its already-installed official package CLI:

```powershell
$sunlintCli = 'D:\nestjs-npm-cache\_npx\d135427ecc649769\node_modules\@sun-asterisk\sunlint\cli.js'
node $sunlintCli --version
node $sunlintCli --all --input=src --format=json --output=node_modules/.cache/pr5-commit4-review/final-src.json --output-summary=node_modules/.cache/pr5-commit4-review/final-src-summary.json *> node_modules/.cache/pr5-commit4-review/final-src.log
node $sunlintCli --all --input=test --format=json --output=node_modules/.cache/pr5-commit4-review/final-test.json --output-summary=node_modules/.cache/pr5-commit4-review/final-test-summary.json *> node_modules/.cache/pr5-commit4-review/final-test.log
node $sunlintCli --all --input=src/comments/comments.service.spec.ts --config=node_modules/.cache/pr5-commit4-review/include-unit.json --format=json --output=node_modules/.cache/pr5-commit4-review/final-unit.json --output-summary=node_modules/.cache/pr5-commit4-review/final-unit-summary.json *> node_modules/.cache/pr5-commit4-review/final-unit.log
```

The temporary, ignored inclusion config sets
`languages.typescript.include` to `["**/*.ts"]` and `exclude` to `["**/*.d.ts"]`.
It disables no rules. The default source scan excludes `*.spec.ts`, so this
explicit unit-file scan is necessary. Files are discovered from disk rather than
Git's tracked-only diff, covering any untracked source/test files too. The final
changed/untracked TypeScript inventory is checked separately against those
inputs: CommentsController, CommentsService, its unit test, Comment E2E tests and
the Article Swagger integration test (five changed TypeScript files; no untracked
TypeScript files at completion). No application dependencies or ESLint configuration are added. The
initial `npx` attempt was interrupted after making no progress; the cached
official package was verified as exactly 1.3.56 and its supported CLI used instead.

Baseline scans from committed Commit 3 produced 73 source files / 125 warnings,
12 test files / 167 warnings, and the explicit service unit file / 0 warnings.
All had zero errors and exit 0. Current scans produce 73 source files / 126
warnings, 12 test files / 171 warnings, and the service unit file / 0 warnings,
with zero errors and exit 0. Comparison normalizes paths and matches rule/message
counts, then reviews locations against the actual code changes. Findings:

- **One new S037 warning:** DELETE anti-cache heuristic. This mutation is not a
  cacheable representation under [HTTP DELETE semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.5); it does not expose viewer-specific GET
  metadata. The existing GET's `private, no-store` header remains verified.
  Demands for legacy Pragma/Expires headers are not grounds to change this API.
- **Four new test warnings:** C041 and S012 flag the intentional wrong-signature
  test secret; two S042 warnings flag deliberately expired and wrong-signature
  JWT fixtures. The expired fixture explicitly sets `expiresIn: -1`; other
  signed fixtures inherit the validated JwtModule TTL. These are false positives,
  not leaked production credentials or tokens lacking expiration.
- **292 pre-existing warnings:** unchanged source/test findings, including
  heuristic C018/C030 messages on the existing safe exception handler, Logger
  construction and DataSource injection. Existing warnings are not globally
  suppressed or claimed to be fully audited by this checkpoint.

No new confirmed security/correctness defect or unresolved security issue was
identified in the changed code. A new oxlint warning about sorting numeric
response statuses was corrected with an explicit numeric comparator. SunLint
scans are rerun afterward. Its default engine runs heuristics plus a limited
ESLint rule and reports that full TypeScript ESLint support/configuration is
unavailable. **Full TypeScript ESLint analysis is NOT VERIFIED**; successful CLI
execution and zero reported errors do not imply complete static-analysis coverage.

Final verification on Node.js 26.13.0: formatting, oxlint, build and
`git diff --check` all exit 0. Focused CommentsService tests pass 38/38 and Comment
E2E tests pass 112/112, each with exit 0. The full unit regression passes 367
tests across 21 suites and full E2E regression passes 562 tests across 11 suites,
both with exit 0 and no `--forceExit`. All three final SunLint scans exit 0.

Commit 3 adds unit coverage for empty/unknown/scoped retrieval, SQL ordering,
deduplicated batch following, anonymous metadata, fixed calls for repeated authors,
and sanitized failures at each query stage. Shared-profile mapper and affected
Article/Profile behavior have regression coverage. GET E2E tests cover multi-author
isolation, timestamp ties across repeated reads, follow/unfollow behavior, optional
auth and Redis failure, private-field exclusion, translated errors and Swagger.
SQL instrumentation checks actual statement counts for 1 and 20 Comments, no
per-author queries, selected columns and skipped Follow work for empty lists.

The previous C: disk exhaustion has been resolved and terminal execution is
available. E2E runs explicitly place Jest's disposable cache on D: inside ignored
`node_modules/.cache/jest-pr5`; no application configuration changes are needed.
Report the actual command exit codes as well as test counts.

Creation is not idempotent. If the INSERT commits but timestamp loading or response
delivery fails, a retry may create another Comment. A concurrent deletion after
the INSERT can also remove the new Comment through the existing cascade before
the response is delivered. No transaction or speculative locking is introduced
to guarantee continued existence after creation.
