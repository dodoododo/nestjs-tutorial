# PR4 Commit 2: create and retrieve articles

Only `POST /api/articles` and `GET /api/articles/:slug` are added. Schema,
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
decides the winner of simultaneous creates. Existing articles are never updated.
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

MySQL deadlocks retry the entire transaction at most three times. Any failed
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

## Verification

Unit tests cover validation, Unicode/byte boundaries, slug normalization and
collisions, pure mapping, transaction manager use, bounded deadlock retries,
error classification, and fixed read counts. Article E2E tests cover the HTTP
contract, ownership, JWT/Redis behavior, collation-equivalent and concurrent
shared tags, simultaneous slug collisions, stored favorite/follow state, and
rollback after article, tag, or relationship persistence failures.

E2E fixtures refuse writes outside `127.0.0.1:3308/nestjs_tutorial_test` and require
the test Redis instance at `127.0.0.1:6380`. Cleanup removes only fixture users,
their cascaded data, uniquely named fixture tags, and fixture revocation keys.
Use Node 26.13.0 as documented in the repository README when running the npm
format, lint, build, unit, and E2E scripts.
