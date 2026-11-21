# PR4 article APIs: Commits 2–6

Commit 2 adds `POST /api/articles` and `GET /api/articles/:slug`. Commit 3 adds
`PUT /api/articles/:slug` and `DELETE /api/articles/:slug`. Commit 4 adds
`GET /api/articles` with filtering and pagination. Commit 5 adds the personalized
`GET /api/articles/feed`. Commit 6 adds
`POST /api/articles/:slug/favorite` and `DELETE /api/articles/:slug/favorite`. Schema,
migrations, `synchronize: false`, and the existing authentication implementation
remain unchanged. The request and single-article response follow the
[RealWorld contract](https://realworld-docs.netlify.app/specifications/backend/endpoints/).

## Input and ownership

POST requires a valid Bearer JWT through `JwtAuthGuard`. The author comes only
from the authenticated principal. Unknown top-level and nested properties,
including author identifiers, are rejected with 400.

The required `article` object contains string `title`, `description`, and `body`.
Title and description are trimmed before validating their nonempty values and
255/1024-character database limits. Body must contain non-whitespace text;
formatting is preserved. `Buffer.byteLength(body, 'utf8')` must be at most
`ARTICLE_BODY_MAX_BYTES` (65,535), including leading/trailing whitespace. Invalid
Unicode containing unpaired surrogates is rejected for all text inputs.

`tagList` can be omitted and defaults to no tags; null is invalid. It must be an
array containing at most 20 strings before deduplication, each nonempty and at
most 64 characters after trimming, NFC normalization, and lowercasing. Invalid
values are rejected rather than coerced or filtered away. Normalized identical
names are deduplicated in the service.

## Slugs and collisions

Slugs are deterministic: NFKD normalization, lowercase, Vietnamese `đ` to `d`,
combining marks removed, runs of non-letter/non-number characters replaced with
hyphens, and outer hyphens removed. Letters and numbers from other scripts remain
readable. Slugs are truncated at 255 Unicode code points without splitting a
surrogate pair; trailing hyphens are removed again. A title containing only
unsupported characters uses `article`.

For example, `Đường đi!` and `DUONG DI` both become `duong-di`. There is no
automatic numeric suffix: a slug already occupied under MySQL's collation
returns localized **409 Conflict**, and the caller must change the title. This
also applies to fallback and truncation collisions. The unique database index
decides the winner of simultaneous creates. A create never overwrites an existing article.
The service translates only violations of the named article slug index to 409.

## Tags and atomic persistence

All creation operations and response reads use the transaction's EntityManager
inside one `READ COMMITTED` TypeORM transaction. The article is inserted first.
Sorted normalized tag names are bulk inserted with a no-op
`ON DUPLICATE KEY UPDATE id = id`; this safely waits for concurrent creators and
preserves existing tag IDs/names. Unlike `INSERT IGNORE`, this does not downgrade
unrelated constraint or storage errors into warnings.

A single `IN` query resolves canonical tag IDs according to the database's
case/accent-insensitive collation, so `cafe` and `café` can resolve to one tag even
though JavaScript normalization retains accents. Distinct returned IDs are bulk
inserted into `article_tags`; its composite primary key enforces relationship
uniqueness. There are no cascade saves or per-tag queries. The returned tag list
uses stored canonical names in database name order.

MySQL deadlocks retry the entire transaction for at most three total attempts. Any failed
transaction rolls back the article, new tags, and associations. Unexpected query
failures retain their stack/cause in server logs and return an article-specific
localized 500 without SQL or driver details; other exceptions are rethrown.

## Retrieval and responses

GET uses `OptionalJwtAuthGuard`. Only an absent Authorization header is anonymous;
invalid, expired, or revoked credentials return 401. Redis revocation outages
remain fail-closed (503) for requests supplying a valid JWT. Anonymous reads do
not invoke Redis. A missing article returns localized 404.

The service uses two reads: one article/public-author projection with correlated
favorite-count, viewer-favorite, and viewer-follow subqueries, then one tag query.
Favorite counts cannot multiply through tag joins. Anonymous viewer flags are
always false, while counts still reflect stored favorite relationships.

`mapArticle` is a pure allowlist function accepting already-loaded article data
and metadata. It formats dates and explicitly maps the public author fields; it
has no repositories or queries and returns no internal IDs, email, hashes, or
tokens. Its per-article input/output types can support later list/feed mapping.

## Update Article (Commit 3)

`PUT /api/articles/:slug` requires the existing JWT guard and Redis revocation
check. It looks up the URL slug, returns 404 if absent and 403 if the authenticated
principal is not the author. Ownership is never taken from request fields.
Supplied invalid/expired/revoked credentials return 401; a Redis outage remains
fail-closed (503) before any article write.

The nested `article` object is required. Only `title`, `description`, and `body`
are allowed, all optional. `UpdateArticleDto` uses Swagger `PickType` and
`PartialType` to inherit Create's validation and transformation rules, with
`skipNullProperties: false` so null is rejected rather than treated as omission.
The same normalized character limits, Unicode checks, nonblank body rule, and
65,535 UTF-8 byte limit apply. `tagList`, author/UUID fields, slug, and other
unknown properties return 400. Omitted fields are preserved. `{ "article": {} }`
returns the current article with 200 after ownership checks, without issuing an
UPDATE or changing its timestamps.

A changed title regenerates the slug with the existing utility. An unchanged
title (after trimming), or an update to only description/body, keeps the current
slug, including a previously stored custom slug. The collision precheck uses
MySQL collation and excludes the article's own UUID; a case/accent-equivalent
value belonging to the same article is allowed. A genuinely conflicting slug
returns localized 409. The unique index independently handles races after a
successful precheck, also returning 409 instead of overwriting another article.

The article UUID, author, creation timestamp, tag links, and favorites survive a
slug change. The response reuses the existing Single Article DTO and pure
mapper, including stored favorite counts and viewer-specific metadata. After
renaming, the new slug resolves; a distinct old slug returns 404. Slug lookup
continues to follow MySQL's case/accent-insensitive collation, so equivalent
spellings can still resolve naturally. There are no aliases or redirects.

## Mutation transactions and concurrency

Update and delete use short `READ COMMITTED` transactions and a minimal
`SELECT ... FOR UPDATE` projection of the target article. This serializes
mutations to that resource and holds the ownership check valid through the
write. Writes also include both UUID and principal author ID in their criteria.
All queries use the transaction manager; no Redis locks or external calls occur
inside the transaction. Update loads its response before commit, so any write
or response-query failure rolls back the update.

Only supplied fields are written: simultaneous description/body updates preserve
both changes. Simultaneous writes to the same field use the last successful
serialized write. If another mutation first removes or changes a distinct URL
slug, a waiting request for that old slug returns 404. Slug prechecks do not
reserve a name; the database constraint arbitrates competing articles.
Deadlocks retry from a fresh transaction and ownership read, bounded to three
total attempts. Persistent unexpected database failures use the existing
sanitized article error, with a single server log preserving the stack/cause.
Expected 403/404/409 errors and non-query exceptions are propagated unchanged.

## Delete Article (Commit 3)

`DELETE /api/articles/:slug` has the same authentication, existence, and author
checks, then deletes only that UUID and owner. Success returns **204 No Content**
with no response body; a repeated deletion returns **404**. Concurrent deletes
produce one success and subsequent 404s. Concurrent update/delete requests do
not recreate the article after deletion.

MySQL's existing `ON DELETE CASCADE` foreign keys remove `article_tags` and
`article_favorites` in the same transaction. The service does not manually
delete these children. Reusable Tag rows, users, unrelated articles, and their
relationships remain intact.

There is no Comment entity/table yet. PR5 must reference the stable article UUID
and define its deletion foreign key policy. Polymorphic `attachments` contain
an `attachable_type`/`attachable_id` pair without a resource foreign key. Future
article attachments will therefore need an explicit cleanup policy; this
checkpoint does not introduce article attachment operations or speculative
cleanup of those records.

## List Articles (Commit 4)

`GET /api/articles` uses the existing `OptionalJwtAuthGuard`. Anonymous requests
succeed without consulting Redis. Supplied invalid, expired, incorrectly signed,
or revoked JWTs return 401; a Redis revocation failure remains fail-closed (503).
The JWT strategy supplies the viewer identity; the query cannot override it.

The collection follows the current [RealWorld multiple-articles response](https://realworld-docs.netlify.app/specifications/backend/api-response-format/#multiple-articles):
`{ "articles": [...], "articlesCount": n }`. `ArticlesResponseDto` explicitly
declares an array of `ArticleSummaryDto`, derived from the existing article DTO
with `body` omitted. Body is also excluded from the SQL projection, rather than
loaded and discarded. `mapArticleSummary` is a pure public-field allowlist with
no repositories, queries or injected services. Single-article mapping reuses it
and adds body. Dates use ISO strings; metadata and tag arrays are already loaded.
Author responses contain only username, bio, image and following.

### Query policy

Only `tag`, `author`, `favorited`, `limit` and `offset` are accepted. The route
uses the existing transforming, whitelisting `ValidationPipe` with
`forbidNonWhitelisted: true`. Swagger describes every parameter and its bounds.

- `tag`: trimmed, NFC normalized, lowercased and NFC normalized again, using
  Create's existing normalization. It must contain 1–64 Unicode characters.
- `author` and `favorited`: trimmed, 3–50 characters, retaining case and accents
  just like username writes. Equality follows the existing MySQL collation.
  `favorited` names the user whose favorites are being filtered, independently
  of the authenticated viewer. It is available to anonymous requests.
- `limit`: defaults to 20 only when omitted; integer 1–100. The maximum 100 is
  this project's explicit pagination policy.
- `offset`: defaults to 0 only when omitted; integer 0–9,007,199,254,740,991
  (`Number.MAX_SAFE_INTEGER`). Offsets past the total return an empty page
  together with the matching total.

All supplied empty values, including whitespace-only filters, return 400.
Filter arrays, objects, null and invalid Unicode are rejected. Pagination
accepts only unsigned decimal digit strings (leading zeros allowed); signs,
whitespace, fractions, exponent/hex notation, NaN, Infinity, unsafe numbers,
arrays, objects, and partial numeric strings return 400. Defaults never hide
malformed values. Repeated parameters and bracket/object syntax are rejected,
as are unknown query keys. Transformation helpers live in a separate utility
file. Use `x-lang` or `Accept-Language` for localized errors; `lang` is not an
allowed list query key.

Examples: `/api/articles?tag=nestjs&author=jacob&limit=10` and
`/api/articles?favorited=alice&offset=20`.

### Filtering, paging and bounded queries

Supplied username filters are resolved to IDs using minimal User projections
and database collation. A missing author or favoriting user explicitly returns
`{ "articles": [], "articlesCount": 0 }` before querying articles. An unknown tag
naturally matches no articles. Every supplied filter combines with AND, and
all external values are bound SQL parameters.

Tag and favorite filters use correlated `EXISTS` subqueries through ArticleTag,
Tag and ArticleFavorite. These predicates do not multiply article rows, even
with multiple tags and favorites. Only the many-to-one author is joined into
the page, so direct LIMIT/OFFSET is correct without a separate ID-page query.
The count uses the same filters before pagination. Ordering is
`article.createdAt DESC, article.id DESC`; the UUID breaks timestamp ties.

A nonempty unfiltered list executes exactly three SQL statements:

1. Count all matching articles before pagination.
2. Select the requested page's public fields and author, with indexed
   correlated counts for favoritesCount and, when authenticated, viewer
   favorite and author-follow state.
3. Load all tags for page article IDs in one `IN` query, in stored name order.

Each supplied username filter adds one lookup (at most two). JWT authentication
adds its existing one-user lookup. Thus there are at most five list retrieval
statements, or six including authentication, independent of page size. Empty
and out-of-range pages skip the page/tag reads. No mapping loop performs SQL;
tag and raw metadata maps are keyed by article UUID. Tag filtering does not
truncate the article's complete tagList. Anonymous flags are always false,
while favorite counts remain accurate. Existing database indexes support these
lookups; no schema change or dependency is needed.

Count, page and tags are separate reads, so concurrent writes can change data
between them; this endpoint does not promise snapshot consistency. Deep offset
pagination can become slower as the offset grows. The deterministic order
stabilizes unchanged data, without promising stable pages across new writes.

The collection GET and static `GET feed` are declared before `GET :slug`.
Ordinary slugs continue to use the single-article handler.

## Personalized Feed (Commit 5)

`GET /api/articles/feed` requires the existing `JwtAuthGuard`. Missing, invalid,
expired, incorrectly signed or revoked credentials return 401. Redis revocation
failures retain the existing fail-closed 503 response. The viewer ID comes only
from the authenticated principal. Viewer/user IDs in query parameters return
400; a GET request body cannot change the viewer or feed membership.

The feed follows the [RealWorld Feed contract](https://realworld-docs.netlify.app/specifications/backend/endpoints/#feed-articles)
and reuses `ArticlesResponseDto`, `ArticleSummaryDto` and `mapArticleSummary`.
Body is absent from both the SQL projection and response, and authors expose
only username, bio, image and following. Feed does not introduce another response
schema or mapper.

`FeedArticlesQueryDto` uses Swagger `PickType` to inherit only `limit` and
`offset` from the List DTO, including its defaults, transformation functions,
validation and API documentation. Defaults remain 20 and 0, the limit is 1–100,
and offset is a nonnegative safe integer. The strict decimal, empty, repeated,
structured and unknown-parameter rules above apply unchanged. `tag`, `author`
and `favorited` are unsupported and return 400.

Membership uses a parameterized correlated `EXISTS` predicate on Follow:
`followerId = authenticated viewer ID AND followingId = article.authorId`.
The direction is important: a user following the viewer does not add that user's
articles. No followed-ID list is loaded into application memory. The existing
unique `(follower_id, following_id)` Follow index and Article indexes support
the query; no migration is required. Unrelated authors and the viewer's own
articles are not included automatically. A viewer following nobody, or following
only authors with no articles, receives exactly
`{ "articles": [], "articlesCount": 0 }`. Unfollowing changes subsequent feeds.

List and Feed share the private `loadArticlesPage` method. Each endpoint builds
only its membership predicates; the shared loader counts those matches, orders
by `article.createdAt DESC, article.id DESC`, applies limit/offset, loads the
public article/author projection plus favorite and follow subqueries, batches
all page tags, and calls the pure mapper. No one-to-many page joins multiply
articles, and no per-article mapping loop executes SQL. All stored tags are
returned, favorite counts reflect actual relationships, and viewer favorite
state uses the authenticated viewer. `author.following` is queried using the
same metadata logic as List, rather than hardcoded to true.

A nonempty Feed request executes three retrieval statements (count, page with
metadata, batch tags), plus the JWT strategy's user lookup: four SQL statements
total at both page sizes 1 and 20. Empty and out-of-range feeds execute only the
count after authentication and retain the full matching total. SQL logger tests
verify the fixed query count, batch tag retrieval, metadata selection, and body
and private-column exclusion from feed retrieval. The existing JWT lookup is
unchanged.

The static Feed route is registered before `:slug`. An anonymous request to
`/api/articles/feed` therefore returns 401 even if an Article with slug `feed`
exists; authenticated requests use the feed handler. Creation and editing rules
are unchanged, so this one static GET path takes precedence over single-article
lookup for that slug. No additional slug values are reserved.

Count, page and metadata retain List's separate-read consistency limitation.
A concurrent unfollow can change the count/page or following metadata between
reads; following normally remains true when data is unchanged. No long-lived
transaction is added. Deep offsets retain the existing performance cost.
Unexpected persistence errors reuse the article-specific localized 500 and
server-side logging without returning SQL or driver details. Swagger documents
required Bearer authentication, the two query parameters, the shared successful
response, and validation/authentication/availability errors.

## Favorite and Unfavorite Article (Commit 6)

Both endpoints require the existing Bearer `JwtAuthGuard`. Missing, invalid,
expired, incorrectly signed or revoked tokens return 401; Redis revocation
outages remain fail-closed (503). The viewer ID comes exclusively from the
authenticated principal. Any authenticated user may favorite an existing
article, including its author. Article ownership is not required.

No body is required. An optional empty JSON object is accepted. The small
`EmptyFavoriteInputPipe` rejects nonempty body/query objects, arrays and other
supplied values with 400; neither userId nor articleId can be supplied to choose
the affected relationship. Use `x-lang` or `Accept-Language` for localization.
Swagger documents optional empty input, required JWT, the existing Single
Article success schema and expected error statuses.

The [RealWorld favorite/unfavorite endpoints](https://realworld-docs.netlify.app/specifications/backend/endpoints/#favorite-article)
return a Single Article, including body. This project's explicit policies are:

- First favorite: **200**, with `favorited: true` and the persisted count.
- Repeated favorite by the same user: **409**, with
  `articles.ALREADY_FAVORITED` in English or Vietnamese. This status policy is
  project-specific, rather than prescribed by RealWorld.
- Other users may favorite the same article independently.
- Unfavorite, repeated unfavorite, or unfavorite without an existing favorite:
  **200**, with the Single Article and `favorited: false` in normal operation.
- Unknown article slug: **404** for either operation. Unfavorite does not return
  204 because its response contains the updated Article.

Example requests (no body):

```http
POST /api/articles/understanding-nestjs/favorite
Authorization: Bearer <JWT>
```

Example 200 response:

```json
{
  "article": {
    "slug": "understanding-nestjs",
    "title": "Understanding NestJS",
    "description": "A practical introduction",
    "body": "NestJS is a backend framework...",
    "tagList": ["nestjs", "typescript"],
    "createdAt": "2026-11-20T10:00:00.000Z",
    "updatedAt": "2026-11-20T10:00:00.000Z",
    "favorited": true,
    "favoritesCount": 1,
    "author": {
      "username": "jacob",
      "bio": null,
      "image": null,
      "following": false
    }
  }
}
```

```http
DELETE /api/articles/understanding-nestjs/favorite
Authorization: Bearer <JWT>
```

The DELETE's 200 response has the same complete Article shape; for this example
its `favorited` becomes false and `favoritesCount` becomes 0. Repeating POST
returns a 409 response whose message is `You have already favorited this article`
or `Bạn đã yêu thích bài viết này` when Vietnamese is selected.

### Atomic writes, concurrency and errors

The existing `article_favorites` composite primary key `(user_id, article_id)`
enforces uniqueness. Favorite uses a direct INSERT, with no relationship
existence precheck. Only `ER_DUP_ENTRY` naming `PRIMARY` or
`article_favorites.PRIMARY` from that specific INSERT becomes the translated
409. Unrelated unique keys, foreign-key failures, and errors in response reads
are not mistaken for duplicate favorites. Expected conflicts are not logged as
unexpected errors.

Unfavorite uses a direct DELETE scoped by both the resolved article UUID and
authenticated user UUID. It does not check whether that relationship exists.
Other users' favorites and this user's favorites on other articles survive.
Neither operation issues an Article UPDATE or changes content, slug, author,
timestamps or tags. Counts come from real stored relationships; no denormalized
counter, cache or migration is introduced.

Each operation performs a short `READ COMMITTED` transaction: resolve only the
article UUID/slug with a shared `pessimistic_read` lock, insert/delete the
relationship, and load the existing Single Article before commit. This is a
multi-statement operation: the transaction protects the article against
concurrent deletion/renaming and rolls back the write if response loading fails.
The shared lock coordinates with the existing update/delete exclusive lock
while allowing concurrent favorites. No ownership check, Redis lock, application
mutex or broad exclusive article lock is added.

Synchronized duplicate favorites yield one 200 and one 409 and one persisted
relationship. Concurrent repeated unfavorites remain 200. If deletion obtains
the article lock first, a waiting favorite returns 404; if favorite obtains its
lock first, it completes before deletion cascades the relationship. Existing
article/user foreign keys retain their cascade behavior.

The existing bounded mutation retry loop retries only genuine
`ER_LOCK_DEADLOCK`, at most three total attempts, each with a fresh transaction.
Unexpected query failures log their original stack with the operation and safe
article/user IDs, preserve the original exception as a server-side cause, and
return the article-specific translated persistence error without SQL/driver
details. Non-query exceptions propagate unchanged. Authentication errors keep
their existing handling; article failures never use auth service messages.

### Shared responses and read consistency

Responses reuse `loadArticle`, `ArticleResponseDto` and the pure `mapArticle`.
The loader uses one public article/author query with favorite/follow subqueries
and one query for all tags. There is no SQL inside mapping or per-tag loop.
Each endpoint uses four SELECTs (JWT user lookup, locked article lookup, public
article with metadata, batch tags), one relationship write and transaction
control statements. The number stays fixed with 20 tags. Existing List/Feed
batch metadata and their query counts are unchanged.

Get, List, favorited-username filtering and Feed all observe the persisted
relationships through their existing metadata queries. Viewer favorite states
remain independent and author.following still comes from Follow.

The response describes metadata visible to its read within the transaction;
concurrent changes by other users may commit afterward, so a count is not a
promise about the state when the client receives it. A concurrent opposite
operation on a previously absent relationship can also change viewer state
before metadata is read. No snapshot guarantee across follow/tag reads is added.
List/Feed retain their previously documented separate-read limitations.

## Verification

Unit tests cover validation, Unicode/byte boundaries, slug normalization and
collisions, pure mapping, transaction manager use, bounded deadlock retries,
error classification, and fixed read counts. Article E2E tests cover the HTTP
contract, ownership, JWT/Redis behavior, collation-equivalent and concurrent
shared tags, simultaneous slug collisions, stored favorite/follow state, and
rollback after article, tag, or relationship persistence failures.

Commit 3 adds shared Create/Update validation checks, author-only mutations,
partial/empty updates, slug changes and collation-equivalent collisions,
database-level slug races synchronized after both prechecks, disjoint updates,
concurrent delete/update handling, preserved tag/favorite metadata, empty 204
responses, and rollback of both writes and deletion cascades after injected
persistence failures. Swagger tests verify only Create/Get/Update/Delete are
exposed, with Update accepting exactly its three optional fields. Commit 4
updates the Swagger assertion to include List, all five query parameters and
the body-free summary schema.

Commit 4 unit tests cover strict query validation/defaults/normalization,
missing-user early returns, parameterized combined filters, empty-page totals,
minimal projections, ID-based batch metadata mapping, anonymous flags and
sanitized persistence errors. E2E coverage adds default and explicit pagination,
timestamp ties, collation-aware combined filters, full tag lists, duplicate
prevention, anonymous/authenticated metadata, malformed and repeated queries,
and the existing JWT/Redis security cases for List. A real TypeORM SQL logger
asserts three anonymous statements and four authenticated statements at both
page sizes 1 and 20, verifies batch tags and excludes body/private columns from
list retrieval. All fixtures use the isolated test services below.

Commit 5 adds Feed DTO inheritance/validation tests and service tests for the
Follow predicate direction, parameter binding, shared metadata mapping, empty
page totals, concurrent membership changes and sanitized persistence failures.
Feed E2E coverage includes one/multiple/no followed authors, authors with no
articles, reverse follows, self exclusion, subsequent unfollows, viewer isolation,
deterministic paging, actual favorites and full tag lists, strict validation,
JWT/Redis failures, static-route precedence and the shared Swagger schema. All
previous List filters and single-article operations remain regression-tested.

Commit 6 adds input validation, scoped writes, narrow constraint classification,
article-domain translations, deadlock retry bounds, original error causes and
safe logging tests. E2E tests synchronize duplicate inserts and both article
deletion lock orderings, exercise repeated concurrent unfavorites, independent
users and own favorites, validate Get/List/Feed integration, preserve content
and timestamps, check rollback after injected persistence failures, and count
response reads with 20 tags. JWT/Redis and Swagger coverage includes both new
operations, and existing List/Feed query-count tests remain unchanged.

E2E fixtures refuse writes outside `127.0.0.1:3308/nestjs_tutorial_test` and require
the test Redis instance at `127.0.0.1:6380`. Cleanup removes only fixture users,
their cascaded data, uniquely named fixture tags, and fixture revocation keys.
Use Node 26.13.0 as documented in the repository README when running the npm
format, lint, build, unit, and E2E scripts.
