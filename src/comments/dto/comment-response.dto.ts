import { ApiProperty } from '@nestjs/swagger';
import { ProfileDto } from '../../profiles/dto/profile-response.dto';

export class CommentDto {
  @ApiProperty({ format: 'uuid', description: 'Public Comment UUID' })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ type: ProfileDto })
  author!: ProfileDto;
}

export class CommentResponseDto {
  @ApiProperty({ type: CommentDto })
  comment!: CommentDto;
}
