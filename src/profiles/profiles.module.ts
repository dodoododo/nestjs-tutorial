import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { Follow } from '../database/entities/follow.entity';
import { User } from '../database/entities/user.entity';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([User, Follow])],
  controllers: [ProfilesController],
  providers: [ProfilesService],
})
export class ProfilesModule {}
