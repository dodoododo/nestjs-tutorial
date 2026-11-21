# PR5 Comment APIs: Commits 2–3

Commit 2 implements `POST /api/articles/:slug/comments`. Commit 3 adds
`GET /api/articles/:slug/comments` with optional authentication and shared public
profile mapping.
The nested request and Single Comment response follow the
[RealWorld Add Comment contract](https://realworld-docs.netlify.app/specifications/backend/endpoints/#add-comments-to-an-article).
DELETE Comment and later features are not implemented.

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

## Persistence and response

The service looks up the Article by its current slug and selects its stable UUID.
Unknown slugs return a Comment-domain 404 before any write. Any authenticated user
can comment, including the Article's owner. Article authorship is independent of
Comment authorship, which comes only from `principal.user.id`.

The service fetches the author's public profile fields before writing, then saves
an explicit allowlist of `articleId`, `authorId` and `body`. TypeORM generates the
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

## Authentication, races and errors

- Missing, invalid, expired, incorrectly signed, revoked or deleted-user JWTs
  return 401 through the existing authentication implementation.
- Redis revocation-check unavailability remains fail-closed with 503.
- A missing author during the service's profile lookup returns 401 without a
  write. An author deletion after that lookup can cause an author foreign-key
  failure; it is sanitized and logged as 500, never mislabeled as Article 404.
- If insertion fails with `ER_NO_REFERENCED_ROW_2` specifically naming
  `FK_comments_article_id`, the service checks the previously resolved Article
  UUID again. Only confirmed absence becomes 404. Other foreign-key violations,
  a still-present Article or a failed confirmation lookup remain unexpected
  failures. Existing foreign keys prevent orphan comments without pessimistic
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
201/400/401/404/500/503 statuses. GET documents optional authentication, the slug,
ordering, no pagination, shared Multiple Comments response and
200/401/404/500/503 statuses. DELETE is not documented as implemented.

## Verification and limits

Run with Node.js 26.13.0 against the migrated isolated test services:

```powershell
npm.cmd test -- --runInBand src/comments
npm.cmd run test:e2e -- --runInBand comments.e2e-spec.ts --cacheDirectory=./node_modules/.cache/jest-pr5
npm.cmd run format
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
Run E2E suites serially because existing database tests roundtrip migrations.
No development or production database is used.

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
