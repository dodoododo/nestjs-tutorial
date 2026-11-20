import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import sharp from 'sharp';

import {
  animatedAvatarBuffer,
  avatarBuffer,
  avatarFile,
} from '../../test/helpers/avatar-fixtures';
import { AvatarImageService } from './avatar-image.service';
import {
  AVATAR_FORMATS,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DIMENSION,
} from './avatar.constants';

describe('AvatarImageService', () => {
  let service: AvatarImageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AvatarImageService,
        { provide: I18nService, useValue: { t: (key: string) => key } },
      ],
    }).compile();
    service = moduleRef.get(AvatarImageService);
  });

  it.each(['jpeg', 'png', 'webp'] as const)(
    'decodes and re-encodes %s content with a trusted extension',
    async (format) => {
      const output = await service.validate(
        avatarFile(await avatarBuffer(format), AVATAR_FORMATS[format].mime),
      );
      expect(output.mime).toBe(AVATAR_FORMATS[format].mime);
      expect(output.extension).toBe(AVATAR_FORMATS[format].extension);
      expect((await sharp(output.buffer).metadata()).format).toBe(format);
    },
  );

  it('rejects a missing file', async () => {
    await expect(service.validate(undefined)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects oversized buffers before attempting to decode', async () => {
    await expect(
      service.validate(avatarFile(Buffer.alloc(AVATAR_MAX_BYTES + 1))),
    ).rejects.toThrow(PayloadTooLargeException);
  });

  it('rejects unsupported MIME types even when the buffer is a valid image', async () => {
    await expect(
      service.validate(avatarFile(await avatarBuffer(), 'text/html')),
    ).rejects.toThrow(UnsupportedMediaTypeException);
  });

  it('rejects mismatched MIME and actual image format', async () => {
    await expect(
      service.validate(avatarFile(await avatarBuffer('jpeg'), 'image/png')),
    ).rejects.toThrow(BadRequestException);
  });

  it.each([
    Buffer.from('<html><script>alert(1)</script></html>'),
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
    ),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(0),
  ])(
    'rejects invalid or unsupported content disguised as PNG',
    async (buffer) => {
      await expect(service.validate(avatarFile(buffer))).rejects.toThrow(
        BadRequestException,
      );
    },
  );

  it('strips metadata and appended content rather than publishing the input bytes', async () => {
    const input = await sharp(await avatarBuffer('jpeg'))
      .withExif({ IFD0: { Copyright: 'private-metadata' } })
      .jpeg()
      .toBuffer();
    const output = await service.validate(
      avatarFile(
        Buffer.concat([input, Buffer.from('<script>untrusted</script>')]),
        'image/jpeg',
      ),
    );
    const metadata = await sharp(output.buffer).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(output.buffer.includes(Buffer.from('untrusted'))).toBe(false);
    expect(output.buffer.includes(Buffer.from('private-metadata'))).toBe(false);
  });

  it('bounds the dimensions of large valid avatars', async () => {
    const output = await service.validate(
      avatarFile(await avatarBuffer('png', 2048, 1024)),
    );
    const metadata = await sharp(output.buffer).metadata();
    expect(metadata.width).toBe(AVATAR_MAX_DIMENSION);
    expect(metadata.height).toBe(512);
  });

  it('rejects excessive decoded pixels even when the compressed input is small', async () => {
    await expect(
      service.validate(avatarFile(await avatarBuffer('png', 5000, 4000))),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects animated WebP rather than publishing only its first frame', async () => {
    const buffer = await animatedAvatarBuffer();
    expect((await sharp(buffer).metadata()).pages).toBe(2);
    await expect(
      service.validate(avatarFile(buffer, 'image/webp')),
    ).rejects.toThrow(BadRequestException);
  });
});
