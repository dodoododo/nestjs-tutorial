import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  ARTICLE_BODY_MAX_BYTES,
  ARTICLE_DESCRIPTION_MAX_LENGTH,
  ARTICLE_TAG_MAX_COUNT,
  ARTICLE_TITLE_MAX_LENGTH,
  TAG_NAME_MAX_LENGTH,
} from '../constants/article.constant';

export function normalizeTag(name: string): string {
  return name.trim().normalize('NFC').toLowerCase().normalize('NFC');
}

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateArticleDto {
  @ApiProperty({ maxLength: ARTICLE_TITLE_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(ARTICLE_TITLE_MAX_LENGTH)
  @Matches(/^[^\p{Surrogate}]*$/u, {
    message: 'title must contain valid Unicode',
  })
  title!: string;

  @ApiProperty({ maxLength: ARTICLE_DESCRIPTION_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(ARTICLE_DESCRIPTION_MAX_LENGTH)
  @Matches(/^[^\p{Surrogate}]*$/u, {
    message: 'description must contain valid Unicode',
  })
  description!: string;

  @ApiProperty({
    description:
      'Nonblank text; maximum 65535 UTF-8 bytes. Formatting is preserved.',
  })
  @IsString()
  @Matches(/\S/u, { message: 'body must not be blank' })
  @Matches(/^[^\p{Surrogate}]*$/u, {
    message: 'body must contain valid Unicode',
  })
  @ValidateBy({
    name: 'maxArticleBodyBytes',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        Buffer.byteLength(value, 'utf8') <= ARTICLE_BODY_MAX_BYTES,
      defaultMessage: () =>
        `body must not exceed ${ARTICLE_BODY_MAX_BYTES} UTF-8 bytes`,
    },
  })
  body!: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: ARTICLE_TAG_MAX_COUNT,
    description:
      'Trimmed, NFC normalized, lowercase tags; at most 64 characters each.',
  })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((tag: unknown) =>
          typeof tag === 'string' ? normalizeTag(tag) : tag,
        )
      : value,
  )
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(ARTICLE_TAG_MAX_COUNT)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(TAG_NAME_MAX_LENGTH, { each: true })
  @Matches(/^[^\p{Surrogate}]*$/u, {
    each: true,
    message: 'tags must contain valid Unicode',
  })
  tagList?: string[];
}

export class CreateArticleRequestDto {
  @ApiProperty({ type: CreateArticleDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateArticleDto)
  article!: CreateArticleDto;
}
