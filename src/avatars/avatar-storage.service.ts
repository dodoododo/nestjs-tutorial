import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  AVATAR_FILE_NAME_PATTERN,
  AVATAR_PUBLIC_PATH,
  type AvatarExtension,
} from './avatar.constants';

@Injectable()
export class AvatarStorageService {
  private readonly logger = new Logger(AvatarStorageService.name);
  readonly directory: string;

  constructor(config: ConfigService) {
    this.directory = resolve(
      config.get<string>('AVATAR_STORAGE_DIR') ??
        join(process.cwd(), 'storage', 'avatars'),
    );
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async write(buffer: Buffer, extension: AvatarExtension) {
    await this.ensureDirectory();
    const fileName = `${randomUUID()}.${extension}`;
    const handle = await open(this.pathFor(fileName), 'wx', 0o644);
    try {
      try {
        await handle.writeFile(buffer);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      try {
        await this.remove(fileName);
      } catch {
        this.logger.error(`Incomplete avatar cleanup failed: ${fileName}`);
      }
      throw error;
    }
    return { fileName, url: `${AVATAR_PUBLIC_PATH}/${fileName}` };
  }

  fileNameFromUrl(url: string | null): string | null {
    const prefix = `${AVATAR_PUBLIC_PATH}/`;
    if (!url?.startsWith(prefix)) {
      return null;
    }
    const fileName = url.slice(prefix.length);
    return AVATAR_FILE_NAME_PATTERN.test(fileName) ? fileName : null;
  }

  async remove(fileName: string): Promise<void> {
    try {
      await unlink(this.pathFor(fileName));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private pathFor(fileName: string): string {
    if (!AVATAR_FILE_NAME_PATTERN.test(fileName)) {
      throw new Error('Invalid generated avatar filename');
    }
    return join(this.directory, fileName);
  }
}
