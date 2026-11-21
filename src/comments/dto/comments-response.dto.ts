import { ApiProperty } from '@nestjs/swagger';
import { CommentDto } from './comment-response.dto';

export class CommentsResponseDto {
  @ApiProperty({ type: [CommentDto] })
  comments!: CommentDto[];
}
