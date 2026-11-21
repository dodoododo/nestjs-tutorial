import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsObject,
  IsString,
  Matches,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { COMMENT_BODY_MAX_BYTES } from '../constants/comment.constant';

export class CreateCommentDto {
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
    name: 'maxCommentBodyBytes',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        Buffer.byteLength(value, 'utf8') <= COMMENT_BODY_MAX_BYTES,
      defaultMessage: () =>
        `body must not exceed ${COMMENT_BODY_MAX_BYTES} UTF-8 bytes`,
    },
  })
  body!: string;
}

export class CreateCommentRequestDto {
  @ApiProperty({ type: CreateCommentDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateCommentDto)
  comment!: CreateCommentDto;
}
