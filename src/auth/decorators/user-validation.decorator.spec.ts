import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RegisterRequestDto } from '../dto/register.dto';
import { LoginRequestDto } from '../dto/login.dto';
import { UpdateUserRequestDto } from '../dto/update-user.dto';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
const valid = {
  username: 'jacob',
  email: 'jacob@example.test',
  password: 'StrongPass123!',
};
const types = {
  register: RegisterRequestDto,
  login: LoginRequestDto,
  update: UpdateUserRequestDto,
};
type Kind = keyof typeof types;
function input(kind: Kind, fields: Record<string, unknown>) {
  const user =
    kind === 'register'
      ? { ...valid, ...fields }
      : kind === 'login'
        ? { email: valid.email, password: valid.password, ...fields }
        : fields;
  return pipe.transform({ user }, { type: 'body', metatype: types[kind] });
}

describe('HTTP user DTO validation and normalization', () => {
  describe.each(['register', 'update', 'login'] as const)(
    '%s passwords',
    (kind) => {
      it.each([
        ['a'.repeat(7), kind === 'login'],
        ['a'.repeat(8), true],
        ['a'.repeat(72), true],
        ['a'.repeat(73), false],
        ['\u00e9'.repeat(36), true],
        ['\u00e9'.repeat(37), false],
        ['\u{1f510}'.repeat(18), true],
        ['\u{1f510}'.repeat(18) + 'a', false],
        [' a b c d ', true],
        ['', false],
        [null, false],
        [undefined, kind === 'update'],
        [12345678, false],
        [{}, false],
        [[], false],
        [true, false],
      ])(
        'enforces character and byte boundaries (case %#)',
        async (password, accepted) => {
          const result = input(kind, { password });
          if (accepted) {
            expect((await result).user.password).toBe(password);
          } else {
            await expect(result).rejects.toBeInstanceOf(BadRequestException);
          }
        },
      );
    },
  );

  describe.each(['register', 'update'] as const)('%s username', (kind) => {
    it.each([
      [2, false],
      [3, true],
      [50, true],
      [51, false],
    ] as const)('checks normalized length %i', async (length, accepted) => {
      const username = 'a'.repeat(length);
      const result = input(kind, { username: `  ${username}  ` });
      if (accepted) expect((await result).user.username).toBe(username);
      else await expect(result).rejects.toBeInstanceOf(BadRequestException);
    });
    it.each([null, 123, [], {}, true])(
      'rejects invalid username type %#',
      async (username) => {
        await expect(input(kind, { username })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      },
    );
  });

  describe.each(['register', 'login', 'update'] as const)(
    '%s email',
    (kind) => {
      it('trims and lowercases before validation', async () => {
        expect(
          (await input(kind, { email: '  JACOB@EXAMPLE.TEST  ' })).user.email,
        ).toBe(valid.email);
      });
      it.each([
        [254, true],
        [255, false],
      ] as const)('checks length %i', async (length, accepted) => {
        // Legal local/domain labels; only the total address length differs.
        const email =
          'a'.repeat(64) +
          '@' +
          'b'.repeat(63) +
          '.' +
          'c'.repeat(63) +
          '.' +
          'd'.repeat(length - 193);
        expect(email.length).toBe(length);
        const result = input(kind, { email: `  ${email.toUpperCase()}  ` });
        if (accepted) expect((await result).user.email).toBe(email);
        else await expect(result).rejects.toBeInstanceOf(BadRequestException);
      });
      it.each([null, 123, [], {}, true, 'invalid'])(
        'rejects invalid email %#',
        async (email) => {
          await expect(input(kind, { email })).rejects.toBeInstanceOf(
            BadRequestException,
          );
        },
      );
    },
  );

  it.each(['username', 'email'] as const)(
    'allows omitted update %s, rejects missing registration %s',
    async (field) => {
      expect(
        (await input('update', { [field]: undefined })).user[field],
      ).toBeUndefined();
      await expect(
        input('register', { [field]: undefined }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
  it('rejects missing login email', async () => {
    await expect(input('login', { email: undefined })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it.each([
    ['a'.repeat(65535), true],
    ['a'.repeat(65536), false],
    ['\u20ac'.repeat(21845), true],
    ['\u20ac'.repeat(21845) + 'a', false],
    ['  biography \n ', true],
    ['', true],
    [null, true],
    [undefined, true],
    [42, false],
    [[], false],
    [{}, false],
    [true, false],
  ])(
    'preserves bio whitespace/null and enforces UTF-8 bytes (case %#)',
    async (bio, accepted) => {
      const result = input('update', { bio });
      if (accepted) expect((await result).user.bio).toBe(bio);
      else await expect(result).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});
