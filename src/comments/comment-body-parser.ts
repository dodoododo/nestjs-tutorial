import type { NestExpressApplication } from '@nestjs/platform-express';

// A valid TEXT body can require six JSON bytes per character (e.g. \u0000).
// Allow that expansion plus the envelope, without raising other routes' limit.
export const COMMENT_JSON_MAX_BYTES = 400 * 1024;

export function setupCommentBodyParser(app: NestExpressApplication): void {
  // Register before app.init()/listen(), ahead of Nest's default parsers.
  app.useBodyParser('json', {
    limit: COMMENT_JSON_MAX_BYTES,
    type: (request) =>
      request.method === 'POST' &&
      /^\/api\/articles\/[^/?]+\/comments\/?(?:\?|$)/i.test(
        request.url ?? '',
      ) &&
      request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() ===
        'application/json',
  });
  // Nest detects the registered jsonParser and skips its automatic JSON parser.
  // Keep the default 100 KB parser explicitly for every other JSON request.
  app.useBodyParser('json');
}
