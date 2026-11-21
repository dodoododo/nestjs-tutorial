import { ApiProperty, PartialType, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsObject, ValidateNested } from 'class-validator';
import { CreateArticleDto } from './create-article.dto';

// Inherit normalization and every shared constraint, but allow only omission,
// never null, for the three fields allowed by the Update Article contract.
export class UpdateArticleDto extends PartialType(
  PickType(CreateArticleDto, ['title', 'description', 'body'] as const),
  { skipNullProperties: false },
) {}

export class UpdateArticleRequestDto {
  @ApiProperty({ type: UpdateArticleDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateArticleDto)
  article!: UpdateArticleDto;
}
