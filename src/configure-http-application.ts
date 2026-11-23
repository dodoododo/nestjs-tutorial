import type { NestExpressApplication } from '@nestjs/platform-express';
import { setupCommentBodyParser } from './comments/comment-body-parser';

/** Call once before init/listen so routes and their parsers share one prefix. */
export function configureHttpApplication(
  app: NestExpressApplication,
  globalPrefix = 'api',
): void {
  app.setGlobalPrefix(globalPrefix);
  setupCommentBodyParser(app, globalPrefix);
}
