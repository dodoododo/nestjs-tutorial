# PR4 article APIs: Commits 2 and 3

Commit 2 adds `POST /api/articles` and `GET /api/articles/:slug`. Commit 3 adds
`PUT /api/articles/:slug` and `DELETE /api/articles/:slug`. Schema,
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
exposed, with Update accepting exactly its three optional fields.

E2E fixtures refuse writes outside `127.0.0.1:3308/nestjs_tutorial_test` and require
the test Redis instance at `127.0.0.1:6380`. Cleanup removes only fixture users,
their cascaded data, uniquely named fixture tags, and fixture revocation keys.
Use Node 26.13.0 as documented in the repository README when running the npm
format, lint, build, unit, and E2E scripts.
