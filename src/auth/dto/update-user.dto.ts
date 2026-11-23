import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsObject,
  IsString,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  BCRYPT_MAX_BYTES,
  BIO_MAX_UTF8_BYTES,
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../constants/auth.constant';
import {
  IsPassword,
  IsUserEmail,
  IsUsername,
} from '../decorators/user-validation.decorator';

export class UpdateUserDto {
  @ApiPropertyOptional({
    example: 'jacob',
    minLength: USERNAME_MIN_LENGTH,
    maxLength: USERNAME_MAX_LENGTH,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUsername()
  username?: string;

  @ApiPropertyOptional({
    example: 'jacob@example.com',
    maxLength: EMAIL_MAX_LENGTH,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUserEmail()
  email?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: `Omit to preserve the bio; null clears it. Empty text is allowed. Maximum ${BIO_MAX_UTF8_BYTES} UTF-8 bytes.`,
  })
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsString()
  @ValidateBy({
    name: 'maxBioBytes',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        Buffer.byteLength(value, 'utf8') <= BIO_MAX_UTF8_BYTES,
      defaultMessage: () =>
        `bio must not exceed ${BIO_MAX_UTF8_BYTES} UTF-8 bytes`,
    },
  })
  bio?: string | null;

  @ApiPropertyOptional({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    writeOnly: true,
    description: `Maximum ${BCRYPT_MAX_BYTES} UTF-8 bytes. Returns a fresh JWT and invalidates all earlier JWTs on success.`,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsPassword()
  password?: string;
}

export class UpdateUserRequestDto {
  @ApiProperty({ type: UpdateUserDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateUserDto)
  user!: UpdateUserDto;
}
