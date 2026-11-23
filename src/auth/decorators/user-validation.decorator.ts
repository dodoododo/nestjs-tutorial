import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  MaxLength,
  MinLength,
  ValidateBy,
} from 'class-validator';

import {
  BCRYPT_MAX_BYTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
} from '../constants/auth.constant';

export function IsUsername(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim() : value,
    ),
    IsString(),
    MinLength(USERNAME_MIN_LENGTH),
    MaxLength(USERNAME_MAX_LENGTH),
  );
}

export function IsUserEmail(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim().toLowerCase() : value,
    ),
    IsString(),
    IsEmail(),
    MaxLength(EMAIL_MAX_LENGTH),
  );
}

// Login retains its existing nonempty-only minimum for legacy credentials.
export function IsPassword(newPassword = true): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MinLength(newPassword ? PASSWORD_MIN_LENGTH : 1),
    MaxLength(PASSWORD_MAX_LENGTH),
    ValidateBy({
      name: 'maxBcryptPasswordBytes',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_BYTES,
        defaultMessage: () =>
          `password must not exceed ${BCRYPT_MAX_BYTES} UTF-8 bytes`,
      },
    }),
  );
}
