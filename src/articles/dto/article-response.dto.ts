import { ApiProperty } from '@nestjs/swagger';
import { ProfileDto } from '../../profiles/dto/profile-response.dto';

export class ArticleDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ type: [String] })
  tagList!: string[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty()
  favorited!: boolean;

  @ApiProperty({ minimum: 0 })
  favoritesCount!: number;

  @ApiProperty({ type: ProfileDto })
  author!: ProfileDto;
}

export class ArticleResponseDto {
  @ApiProperty({ type: ArticleDto })
  article!: ArticleDto;
}
