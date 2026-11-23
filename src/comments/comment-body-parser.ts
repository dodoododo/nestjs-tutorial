import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, type Application } from 'express';
import { COMMENT_COLLECTION_PATH } from './constants/comment.constant';

// A valid TEXT body can require six JSON bytes per character (e.g. \u0000).
// Allow that expansion plus the envelope, without raising other routes' limit.
export const COMMENT_JSON_MAX_BYTES = 400 * 1024;

export function setupCommentBodyParser(
  app: NestExpressApplication,
  globalPrefix: string,
): void {
  const prefix = globalPrefix.replace(/^\/+|\/+$/g, '');
  const path = `${prefix ? `/${prefix}` : ''}/${COMMENT_COLLECTION_PATH}`;
  // Native Express route matching handles parameters, case and trailing slash.
  // Register before Nest's parsers; middleware registered by a module is later.
  const server: Application = app.getHttpAdapter().getInstance();
  server.post(path, json({ limit: COMMENT_JSON_MAX_BYTES }));
  // Consumed streams are not parsed twice. Every other JSON route keeps 100 KiB.
  // Nest detects this parser and leaves its default URL-encoded parser enabled.
  app.useBodyParser('json');
}
