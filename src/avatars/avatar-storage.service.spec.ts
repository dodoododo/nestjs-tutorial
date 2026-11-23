import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AvatarStorageService } from './avatar-storage.service';
import {
  AVATAR_FILE_NAME_PATTERN,
  AVATAR_PUBLIC_PATH,
} from './avatar.constants';

describe('AvatarStorageService', () => {
  let directory: string;
  let storage: AvatarStorageService;
  const files: string[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nestjs-avatar-storage-'));
    storage = new AvatarStorageService(
      new ConfigService({ AVATAR_STORAGE_DIR: directory }),
    );
  });

  afterEach(async () => {
    for (const file of files.splice(0)) {
      await unlink(join(directory, file)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
    }
    await rmdir(directory);
  });

  it('writes a server-generated filename and builds a relative public URL', async () => {
    const stored = await storage.write(Buffer.from('sanitized bytes'), 'png');
    files.push(stored.fileName);
    expect(stored.fileName).toMatch(AVATAR_FILE_NAME_PATTERN);
    expect(stored.url).toBe(`${AVATAR_PUBLIC_PATH}/${stored.fileName}`);
    expect(await readFile(join(directory, stored.fileName), 'utf8')).toBe(
      'sanitized bytes',
    );
    await storage.remove(stored.fileName);
    await expect(
      readFile(join(directory, stored.fileName)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    null,
    '/elsewhere/file.png',
    '/public/avatars/../../.env',
    '/public/avatars/file.html',
    '/public/avatars/%2e%2e%2fsecret.png',
    `/public/avatars/${randomUUID()}.png/extra`,
  ])('does not derive deletion paths from untrusted URLs: %j', (url) => {
    expect(storage.fileNameFromUrl(url)).toBeNull();
  });

  it('refuses arbitrary filenames and leaves unrelated files alone', async () => {
    files.push('unrelated.txt');
    await writeFile(join(directory, 'unrelated.txt'), 'keep');
    await expect(storage.remove('../unrelated.txt')).rejects.toThrow(
      'Invalid generated avatar filename',
    );
    await expect(storage.remove('unrelated.txt')).rejects.toThrow(
      'Invalid generated avatar filename',
    );
    expect(await readFile(join(directory, 'unrelated.txt'), 'utf8')).toBe(
      'keep',
    );
  });

  it('treats already-missing generated files as cleaned up', async () => {
    await expect(
      storage.remove(`${randomUUID()}.png`),
    ).resolves.toBeUndefined();
  });
});
