import { ApiProperty, OmitType } from '@nestjs/swagger';
import { ArticleDto } from './article-response.dto';

export class ArticleSummaryDto extends OmitType(ArticleDto, [
  'body',
] as const) {}

export class ArticlesResponseDto {
  @ApiProperty({ type: [ArticleSummaryDto] })
  articles!: ArticleSummaryDto[];

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'All matches before pagination',
  })
  articlesCount!: number;
}
