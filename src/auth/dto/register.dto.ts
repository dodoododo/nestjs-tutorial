import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, ValidateNested } from 'class-validator';

import {
  BCRYPT_MAX_BYTES,
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

export class RegisterDto {
  @ApiProperty({
    example: 'jacob',
    minLength: USERNAME_MIN_LENGTH,
    maxLength: USERNAME_MAX_LENGTH,
  })
  @IsUsername()
  username!: string;

  @ApiProperty({ example: 'jacob@example.com', maxLength: EMAIL_MAX_LENGTH })
  @IsUserEmail()
  email!: string;

  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    writeOnly: true,
    description: `Maximum ${BCRYPT_MAX_BYTES} UTF-8 bytes. Passwords are not normalized or truncated.`,
  })
  @IsPassword()
  password!: string;
}

export class RegisterRequestDto {
  @ApiProperty({ type: RegisterDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => RegisterDto)
  user!: RegisterDto;
}
