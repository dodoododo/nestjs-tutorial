import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { setupAvatarStaticAssets } from './avatars/avatar-static';
import { configureHttpApplication } from './configure-http-application';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureHttpApplication(app);
  await setupAvatarStaticAssets(app);
  setupSwagger(app);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
