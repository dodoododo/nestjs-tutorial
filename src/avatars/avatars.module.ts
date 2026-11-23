import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AvatarImageService } from './avatar-image.service';
import { AvatarStorageService } from './avatar-storage.service';
import { AvatarsController } from './avatars.controller';
import { AvatarsService } from './avatars.service';

@Module({
  imports: [AuthModule],
  controllers: [AvatarsController],
  providers: [AvatarImageService, AvatarStorageService, AvatarsService],
  exports: [AvatarStorageService],
})
export class AvatarsModule {}
