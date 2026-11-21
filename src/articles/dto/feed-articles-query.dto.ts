import { PickType } from '@nestjs/swagger';
import { ListArticlesQueryDto } from './list-articles-query.dto';

// Reuse List's pagination defaults, transformations, validation and Swagger
// metadata without accepting its tag, author or favorited filters.
export class FeedArticlesQueryDto extends PickType(ListArticlesQueryDto, [
  'limit',
  'offset',
] as const) {}
