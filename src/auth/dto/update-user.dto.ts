import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsObject,
  IsString,
  MaxLength,
  MinLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'jacob', minLength: 3, maxLength: 50 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  username?: string;

  @ApiPropertyOptional({ example: 'jacob@example.com', maxLength: 254 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Omit to preserve the bio; null clears it. Empty text is allowed.',
  })
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsString()
  bio?: string | null;

  @ApiPropertyOptional({ minLength: 8, maxLength: 72, writeOnly: true })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @ValidateBy({
    name: 'maxBcryptPasswordBytes',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 72,
      defaultMessage: () => 'password must not exceed 72 UTF-8 bytes',
    },
  })
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
