// MySQL TEXT capacity is measured in UTF-8 bytes, including whitespace.
export const COMMENT_BODY_MAX_BYTES = 65_535;

// Shared with the transport parser so controller path changes stay in sync.
export const COMMENT_COLLECTION_PATH = 'articles/:slug/comments';
