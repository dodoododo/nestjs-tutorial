import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuthService } from '../auth/auth.service';
import { UserResponseDto } from '../auth/dto/user-response.dto';
import { Attachment } from '../database/entities/attachment.entity';
import { User } from '../database/entities/user.entity';
import { AvatarImageService } from './avatar-image.service';
import { AvatarStorageService } from './avatar-storage.service';
import { AVATAR_OWNER_TYPE } from './avatar.constants';

@Injectable()
export class AvatarsService {
  private readonly logger = new Logger(AvatarsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly images: AvatarImageService,
    private readonly storage: AvatarStorageService,
    private readonly authService: AuthService,
  ) {}

  async upload(
    userId: string,
    token: string,
    file: Express.Multer.File | undefined,
  ): Promise<UserResponseDto> {
    const image = await this.images.validate(file);
    // Write a complete, validated file before any database row references it.
    const stored = await this.storage.write(image.buffer, image.extension);
    let result: { response: UserResponseDto; previousUrl: string | null };
    try {
      result = await this.dataSource.transaction(async (manager) => {
        // Serialize replacements for this user, including other app instances.
        const user = await manager.findOne(User, {
          where: { id: userId },
          select: {
            id: true,
            email: true,
            username: true,
            bio: true,
            image: true,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!user) {
          throw new UnauthorizedException();
        }
        const previousUrl = user.image;
        await manager.insert(Attachment, {
          attachableType: AVATAR_OWNER_TYPE,
          attachableId: user.id,
          url: stored.url,
          fileName: stored.fileName,
          fileType: image.mime,
          fileSize: String(image.buffer.length),
        });
        await manager.update(User, user.id, { image: stored.url });
        if (this.storage.fileNameFromUrl(previousUrl)) {
          await manager.delete(Attachment, {
            attachableType: AVATAR_OWNER_TYPE,
            attachableId: user.id,
            url: previousUrl!,
          });
        }
        user.image = stored.url;
        return {
          response: this.authService.getCurrentUser(user, token),
          previousUrl,
        };
      });
    } catch (error: unknown) {
      // A lost COMMIT acknowledgement is ambiguous. Check committed references
      // before deleting; retain the file if the database cannot confirm safety.
      await this.cleanupIfUnreferenced(stored.url);
      throw error;
    }

    await this.cleanupIfUnreferenced(result.previousUrl);
    return result.response;
  }

  private async cleanupIfUnreferenced(url: string | null): Promise<void> {
    const fileName = this.storage.fileNameFromUrl(url);
    if (!fileName || !url) {
      return;
    }
    try {
      // Uploads never reuse generated URLs, so concurrent replacements cannot
      // reactivate a superseded cleanup candidate between this check and unlink.
      const [userReference, attachmentReference] = await Promise.all([
        this.dataSource.getRepository(User).existsBy({ image: url }),
        this.dataSource.getRepository(Attachment).existsBy({ url }),
      ]);
      if (!userReference && !attachmentReference) {
        await this.storage.remove(fileName);
      }
    } catch {
      // A stale file is safer than a missing active avatar. Log a public basename
      // for operators; never expose internal paths or undo a committed update.
      this.logger.warn(`Avatar cleanup deferred: ${fileName}`);
    }
  }
}
