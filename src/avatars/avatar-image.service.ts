import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import sharp from 'sharp';

import {
  AVATAR_FORMATS,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DIMENSION,
  AVATAR_MAX_INPUT_PIXELS,
  type AvatarFormat,
} from './avatar.constants';

@Injectable()
export class AvatarImageService {
  constructor(private readonly i18n: I18nService) {}

  async validate(file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException(this.i18n.t('avatars.FILE_REQUIRED'));
    }
    if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException(this.i18n.t('avatars.INVALID_IMAGE'));
    }
    if (file.buffer.length > AVATAR_MAX_BYTES) {
      throw new PayloadTooLargeException(this.i18n.t('avatars.TOO_LARGE'));
    }
    if (
      !Object.values(AVATAR_FORMATS).some(({ mime }) => mime === file.mimetype)
    ) {
      throw new UnsupportedMediaTypeException(
        this.i18n.t('avatars.INVALID_TYPE'),
      );
    }

    try {
      const image = sharp(file.buffer, {
        failOn: 'warning',
        limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
      });
      const metadata = await image.metadata();
      if (
        !metadata.format ||
        !Object.hasOwn(AVATAR_FORMATS, metadata.format) ||
        (metadata.pages ?? 1) !== 1
      ) {
        throw new Error('Unsupported image content');
      }
      const format = metadata.format as AvatarFormat;
      const output = AVATAR_FORMATS[format];
      if (output.mime !== file.mimetype) {
        throw new Error('Declared MIME does not match image content');
      }

      // Fully decode and re-encode; Sharp strips metadata by default. Keep
      // orientation while bounding decoded pixels, output dimensions and bytes.
      const buffer = await image
        .rotate()
        .resize({
          width: AVATAR_MAX_DIMENSION,
          height: AVATAR_MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toFormat(format)
        .timeout({ seconds: 5 })
        .toBuffer();
      if (buffer.length > AVATAR_MAX_BYTES) {
        throw new PayloadTooLargeException(this.i18n.t('avatars.TOO_LARGE'));
      }
      return { buffer, mime: output.mime, extension: output.extension };
    } catch (error: unknown) {
      if (error instanceof PayloadTooLargeException) {
        throw error;
      }
      throw new BadRequestException(this.i18n.t('avatars.INVALID_IMAGE'));
    }
  }
}
