import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { extname } from 'node:path';

import { AvatarStorageService } from './avatar-storage.service';
import {
  AVATAR_FILE_NAME_PATTERN,
  AVATAR_FORMATS,
  AVATAR_PUBLIC_PATH,
} from './avatar.constants';

export async function setupAvatarStaticAssets(
  app: NestExpressApplication,
): Promise<void> {
  const storage = app.get(AvatarStorageService);
  await storage.ensureDirectory();
  app.use(
    AVATAR_PUBLIC_PATH,
    (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!AVATAR_FILE_NAME_PATTERN.test(req.path.slice(1))) {
        res.sendStatus(404);
        return;
      }
      next();
    },
  );
  app.useStaticAssets(storage.directory, {
    prefix: AVATAR_PUBLIC_PATH,
    index: false,
    redirect: false,
    dotfiles: 'deny',
    fallthrough: true,
    setHeaders: (res: Response, filePath: string) => {
      const extension = extname(filePath).slice(1);
      const format = Object.values(AVATAR_FORMATS).find(
        (value) => value.extension === extension,
      )!;
      res.setHeader('Content-Type', format.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });
}
