import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsString,
  MaxLength,
  MinLength,
  ValidateBy,
  ValidateNested,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'jacob' })
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  username!: string;

  @ApiProperty({ example: 'jacob@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 8, writeOnly: true })
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
  password!: string;
}

export class RegisterRequestDto {
  @ApiProperty({ type: RegisterDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => RegisterDto)
  user!: RegisterDto;
}
