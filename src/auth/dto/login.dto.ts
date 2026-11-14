import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateBy,
  ValidateNested,
} from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'jacob@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    example: 'StrongPass123!',
    writeOnly: true,
  })
  @IsString()
  @IsNotEmpty()
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

export class LoginRequestDto {
  @ApiProperty({ type: LoginDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => LoginDto)
  user!: LoginDto;
}
