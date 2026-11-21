import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { I18nService } from 'nestjs-i18n';
import { QueryFailedError, Repository } from 'typeorm';

import { MYSQL_DUPLICATE_ENTRY_CODE } from '../auth/constants/auth.constant';
import { Follow } from '../database/entities/follow.entity';
import { User } from '../database/entities/user.entity';
import { ProfileResponseDto } from './dto/profile-response.dto';
import { mapProfile } from './mappers/profile-response.mapper';

type ProfileUser = Pick<User, 'id' | 'username' | 'bio' | 'image'>;

@Injectable()
export class ProfilesService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Follow)
    private readonly followsRepository: Repository<Follow>,
    private readonly i18n: I18nService,
  ) {}

  async getProfile(
    username: string,
    currentUserId?: string,
  ): Promise<ProfileResponseDto> {
    const user = await this.findProfileUser(username);
    const following =
      currentUserId === undefined
        ? false
        : await this.followsRepository.existsBy({
            followerId: currentUserId,
            followingId: user.id,
          });

    return this.createProfileResponse(user, following);
  }

  async follow(
    username: string,
    currentUserId: string,
  ): Promise<ProfileResponseDto> {
    const user = await this.findProfileUser(username);

    if (user.id === currentUserId) {
      throw new BadRequestException(this.i18n.t('profiles.SELF_FOLLOW'));
    }

    try {
      // Let the unique index enforce this atomically, including concurrent calls.
      await this.followsRepository.insert({
        followerId: currentUserId,
        followingId: user.id,
      });
    } catch (error: unknown) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code ===
          MYSQL_DUPLICATE_ENTRY_CODE
      ) {
        throw new ConflictException(this.i18n.t('profiles.ALREADY_FOLLOWING'));
      }
      throw error;
    }

    return this.createProfileResponse(user, true);
  }

  async unfollow(
    username: string,
    currentUserId: string,
  ): Promise<ProfileResponseDto> {
    const user = await this.findProfileUser(username);

    // A scoped DELETE is idempotent and does not need an existence query.
    await this.followsRepository.delete({
      followerId: currentUserId,
      followingId: user.id,
    });

    return this.createProfileResponse(user, false);
  }

  private async findProfileUser(username: string): Promise<ProfileUser> {
    const user = await this.usersRepository.findOne({
      where: { username },
      select: { id: true, username: true, bio: true, image: true },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('profiles.NOT_FOUND'));
    }

    return user;
  }

  private createProfileResponse(
    user: ProfileUser,
    following: boolean,
  ): ProfileResponseDto {
    return {
      profile: mapProfile(user, following),
    };
  }
}
