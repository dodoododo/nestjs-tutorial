import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { setupAvatarStaticAssets } from './avatars/avatar-static';
import { setupCommentBodyParser } from './comments/comment-body-parser';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  setupCommentBodyParser(app);
  await setupAvatarStaticAssets(app);
  setupSwagger(app);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
