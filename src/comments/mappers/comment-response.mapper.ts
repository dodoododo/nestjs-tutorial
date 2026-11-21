import type { Comment } from '../../database/entities/comment.entity';
import {
  mapProfile,
  type PublicProfileUser,
} from '../../profiles/mappers/profile-response.mapper';
import type { CommentDto } from '../dto/comment-response.dto';

// Following is supplied by the service for this viewer. No database access or
// assumption that every future response describes the viewer's own comment.
export function mapComment(
  comment: Pick<Comment, 'id' | 'body' | 'createdAt' | 'updatedAt'>,
  author: PublicProfileUser,
  metadata: { following: boolean },
): CommentDto {
  return {
    id: comment.id,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
    body: comment.body,
    author: mapProfile(author, metadata.following),
  };
}
