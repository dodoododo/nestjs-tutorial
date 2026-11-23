# Article database foundation

PR4 Commit 1 adds only entities, a manual migration, limits and database tests.
Entities and migrations are discovered by the existing database globs. No
controller, service, DTO or module registration is needed for this checkpoint.
`synchronize` and `migrationsRun` remain false.

## Schema and relationships

- `articles`: UUID `id` stored as `varchar(36)`, required unique `slug`
  (`varchar(255)`), required `title` (`varchar(255)`), `description`
  (`varchar(1024)`), `body` (`TEXT`), `author_id` (`varchar(36)`), and
  `created_at`/`updated_at` (`datetime(3)`). Both timestamps default to
  `CURRENT_TIMESTAMP(3)`; `updated_at` also updates automatically on writes.
- `tags`: UUID `id` stored as `varchar(36)` and required unique `name`
  (`varchar(64)`). One reusable tag row can belong to many articles.
- `article_tags`: required `article_id` and `tag_id` (`varchar(36)`), with a
  composite primary key on `(article_id, tag_id)` preventing duplicate links.
- `article_favorites`: required `user_id` and `article_id` (`varchar(36)`), with
  a composite primary key on `(user_id, article_id)`. This is the database-level
  unique constraint, including for concurrent inserts. No redundant surrogate
  key or second unique index is needed.

Articles reference users through `author_id`; joins reference their two parent
records. Every foreign key uses `ON DELETE CASCADE` and `ON UPDATE RESTRICT`,
matching the existing Follow conventions. Deleting an author removes their
articles and those articles' links/favorites. Deleting a viewer removes their
favorites. Deleting an article preserves users and reusable tags; deleting a tag
removes only its links. ORM cascade insert/update and eager loading are disabled
by default. No inverse collections or extra fields are added to User.

Comments in PR5 can reference the stable article UUID and cascade when its
article is deleted. Slug changes will not require changing dependent records.
The existing polymorphic attachment model remains unchanged; future article
attachment cleanup must be explicit because it has no resource foreign key.

## Indexes and future queries

- Unique `articles(slug)` supports direct article retrieval and slug collisions.
- `articles(created_at, id)` supports recent ordering with a deterministic UUID
  tie-breaker (`ORDER BY created_at DESC, id DESC`, using a reverse index scan).
- `articles(author_id, created_at, id)` supports author filtering and recent
  articles per author; its prefix also indexes the author foreign key.
- Unique `tags(name)` supports tag reuse and lookup.
- The `article_tags(article_id, tag_id)` primary key loads tags for article IDs
  in batches. Its reverse index `(tag_id, article_id)` supports tag filtering.
- The `article_favorites(user_id, article_id)` primary key supports viewer state
  for multiple articles and articles favorited by one user. Its reverse index
  `(article_id, user_id)` supports favorite counts per article.
- Existing `follows(follower_id, following_id)` plus the author index supports
  selecting articles from followed authors. Multiple-author/tag/favorite filters
  may still need sorting; these indexes do not promise a join-free feed plan.

Later services should batch tag, favorite-count and viewer-state lookups for the
selected page, then pass the fetched data to pure allowlisted response mappers.
Counts must describe the filtered article set, without join multiplication.
Actual query plans and pagination limits belong to subsequent checkpoints.

## Input limits and normalization required in later checkpoints

Limits are defined in `src/articles/constants/article.constant.ts`. Migration
lengths are frozen literals so future constant changes cannot rewrite history.

MySQL `TEXT` stores at most **65,535 bytes** of body content. Both Create Article
(Commit 2) and Update Article (Commit 3) must reject bodies when
`Buffer.byteLength(body, 'utf8') > ARTICLE_BODY_MAX_BYTES` before querying MySQL.
A character-count validator alone is insufficient for multibyte text. Apply the
same shared byte constant in both DTOs, and validate required/nonempty input and
the other column lengths. The schema currently permits empty strings; HTTP
validation is intentionally deferred. SQL strict mode must remain enabled.

Future tag handling should trim, normalize Unicode to NFC, lowercase, reject
empty names, enforce the 64-character limit, and deduplicate the resulting
names. Unique names and slugs inherit the database collation, consistent with
existing User uniqueness. The project's MySQL 8.4 default collation is case and
accent insensitive: database-equivalent tag names must resolve to one existing
tag, even if application normalization produced different strings. Do not add
uncontrolled ORM cascade saves to create tags.

Future services must handle slug/favorite duplicate-key errors explicitly,
including races after an existence check. Article-specific errors should use
`articles.json`; unexpected errors must preserve their cause in appropriate
server logs and return no SQL details to clients. No future endpoint behavior
or translations are implemented here.

## Migration operation

`1795178319697-CreateArticles` follows the existing PR2/PR3 migrations. It creates
parents before join tables and drops dependents first on revert. It does not
alter existing tables. MySQL DDL is not transactionally rollbackable: an
interrupted migration needs inspection before retry. Reverting intentionally
deletes article, tag and favorite data; roundtrip tests refuse to drop nonempty
new tables and run only on `127.0.0.1:3308/nestjs_tutorial_test`.

References: [RealWorld API contract](https://realworld-docs.netlify.app/specifications/backend/endpoints/),
[MySQL storage limits](https://dev.mysql.com/doc/refman/8.4/en/storage-requirements.html).
