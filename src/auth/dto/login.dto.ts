import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, ValidateNested } from 'class-validator';

import {
  BCRYPT_MAX_BYTES,
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
} from '../constants/auth.constant';
import {
  IsPassword,
  IsUserEmail,
} from '../decorators/user-validation.decorator';

export class LoginDto {
  @ApiProperty({ example: 'jacob@example.com', maxLength: EMAIL_MAX_LENGTH })
  @IsUserEmail()
  email!: string;

  @ApiProperty({
    example: 'StrongPass123!',
    minLength: 1,
    maxLength: PASSWORD_MAX_LENGTH,
    writeOnly: true,
    description: `Maximum ${BCRYPT_MAX_BYTES} UTF-8 bytes. Passwords are not normalized or truncated.`,
  })
  @IsPassword(false)
  password!: string;
}

export class LoginRequestDto {
  @ApiProperty({ type: LoginDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => LoginDto)
  user!: LoginDto;
}
