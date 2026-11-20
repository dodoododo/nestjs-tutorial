import sharp from 'sharp';

import type { AvatarFormat } from '../../src/avatars/avatar.constants';

export function avatarBuffer(
  format: AvatarFormat = 'png',
  width = 4,
  height = 4,
) {
  return sharp({
    create: { width, height, channels: 3, background: '#3177a0' },
  })
    .toFormat(format)
    .toBuffer();
}

export function avatarFile(
  buffer: Buffer,
  mimetype = 'image/png',
): Express.Multer.File {
  return {
    fieldname: 'avatar',
    originalname: '../../untrusted.html',
    mimetype,
    buffer,
    size: buffer.length,
  } as Express.Multer.File;
}

export function animatedAvatarBuffer() {
  return sharp({
    create: {
      width: 4,
      height: 8,
      pageHeight: 4,
      channels: 3,
      background: '#3177a0',
    },
  })
    .composite([
      {
        input: Buffer.from([255, 0, 0]),
        raw: { width: 1, height: 1, channels: 3 },
        left: 0,
        top: 5,
      },
    ])
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
}
