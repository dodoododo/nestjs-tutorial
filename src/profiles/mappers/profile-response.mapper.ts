import type { User } from '../../database/entities/user.entity';
import type { ProfileDto } from '../dto/profile-response.dto';

export type PublicProfileUser = Pick<User, 'username' | 'bio' | 'image'>;

// Public allowlist only. Following is resolved by each caller's query layer.
export function mapProfile(
  user: PublicProfileUser,
  following: boolean,
): ProfileDto {
  return {
    username: user.username,
    bio: user.bio,
    image: user.image,
    following,
  };
}
