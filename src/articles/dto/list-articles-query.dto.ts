import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  ARTICLES_DEFAULT_LIMIT,
  ARTICLES_MAX_LIMIT,
  ARTICLES_MAX_OFFSET,
  TAG_NAME_MAX_LENGTH,
} from '../constants/article.constant';
import { normalizeTag } from './create-article.dto';
import {
  parsePaginationInteger,
  trimQueryFilter,
} from '../utils/list-articles-query.util';

export class ListArticlesQueryDto {
  @ApiPropertyOptional({
    description:
      'Tag, trimmed, NFC normalized and lowercased. Empty is invalid.',
    minLength: 1,
    maxLength: TAG_NAME_MAX_LENGTH,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeTag(value) : value,
  )
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(TAG_NAME_MAX_LENGTH)
  @Matches(/^[^\p{Surrogate}]*$/u)
  tag?: string;

  @ApiPropertyOptional({
    description:
      'Author username, trimmed; database collation applies. Empty is invalid.',
    minLength: 3,
    maxLength: 50,
  })
  @Transform(trimQueryFilter)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[^\p{Surrogate}]*$/u)
  author?: string;

  @ApiPropertyOptional({
    description:
      'Username whose favorites to filter, independent of the viewer. Trimmed; empty is invalid.',
    minLength: 3,
    maxLength: 50,
  })
  @Transform(trimQueryFilter)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[^\p{Surrogate}]*$/u)
  favorited?: string;

  @ApiPropertyOptional({
    type: 'integer',
    default: ARTICLES_DEFAULT_LIMIT,
    minimum: 1,
    maximum: ARTICLES_MAX_LIMIT,
    description:
      'Unsigned decimal integer; project maximum 100. Empty is invalid.',
  })
  @Transform(parsePaginationInteger)
  @IsInt()
  @Min(1)
  @Max(ARTICLES_MAX_LIMIT)
  limit: number = ARTICLES_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    type: 'integer',
    default: 0,
    minimum: 0,
    maximum: ARTICLES_MAX_OFFSET,
    description: 'Unsigned decimal safe integer. Empty is invalid.',
  })
  @Transform(parsePaginationInteger)
  @IsInt()
  @Min(0)
  @Max(ARTICLES_MAX_OFFSET)
  offset: number = 0;
}
