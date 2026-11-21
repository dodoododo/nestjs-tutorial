export const ARTICLE_SLUG_MAX_LENGTH = 255;
export const ARTICLE_TITLE_MAX_LENGTH = 255;
export const ARTICLE_DESCRIPTION_MAX_LENGTH = 1024;
// MySQL TEXT capacity is bytes, not JavaScript string length. Both future
// Create and Update DTOs must validate Buffer.byteLength(body, 'utf8').
export const ARTICLE_BODY_MAX_BYTES = 65_535;
export const TAG_NAME_MAX_LENGTH = 64;
export const ARTICLE_TAG_MAX_COUNT = 20;
export const ARTICLE_TRANSACTION_MAX_ATTEMPTS = 3;
export const ARTICLES_DEFAULT_LIMIT = 20;
export const ARTICLES_MAX_LIMIT = 100;
export const ARTICLES_MAX_OFFSET = Number.MAX_SAFE_INTEGER;
