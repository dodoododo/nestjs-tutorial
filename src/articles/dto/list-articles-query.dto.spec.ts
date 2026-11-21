import { ValidationPipe } from '@nestjs/common';
import { ListArticlesQueryDto } from './list-articles-query.dto';

describe('ListArticlesQueryDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  function transform(value: unknown): Promise<ListArticlesQueryDto> {
    return pipe.transform(value, {
      type: 'query',
      metatype: ListArticlesQueryDto,
    });
  }

  it('defaults only omitted pagination and normalizes filters using existing rules', async () => {
    expect(await transform({})).toEqual({ limit: 20, offset: 0 });
    expect(
      await transform({
        tag: ' NESTJS ',
        author: ' Jacob ',
        favorited: ' Alice ',
      }),
    ).toEqual({
      limit: 20,
      offset: 0,
      tag: 'nestjs',
      author: 'Jacob',
      favorited: 'Alice',
    });
    expect((await transform({ tag: ' Tie\u0302\u0301ng ' })).tag).toBe('tiếng');
    expect(
      await transform({ limit: '100', offset: '9007199254740991' }),
    ).toEqual({ limit: 100, offset: Number.MAX_SAFE_INTEGER });
    expect(await transform({ limit: '01', offset: '00' })).toEqual({
      limit: 1,
      offset: 0,
    });
  });

  it.each(['limit', 'offset'] as const)(
    'rejects malformed %s without coercion',
    async (field) => {
      for (const value of [
        '',
        ' ',
        '-1',
        '1.5',
        '1.0',
        '1e2',
        '0x10',
        '+1',
        ' 1',
        '1 ',
        '1\n',
        '1\r',
        '1\t',
        '1x',
        'NaN',
        'Infinity',
        '9007199254740992',
        '9'.repeat(400),
        ['1'],
        ['1', '2'],
        {},
        { nested: '1' },
        null,
        true,
      ]) {
        await expect(transform({ [field]: value })).rejects.toMatchObject({
          status: 400,
        });
      }
    },
  );

  it.each([
    { limit: '0' },
    { limit: '101' },
    { offset: '-0' },
    { unknown: 'x' },
    { 'tag[]': 'nestjs' },
    { 'limit[value]': '1' },
  ])('rejects out-of-policy input (case %#)', async (value) => {
    await expect(transform(value)).rejects.toMatchObject({ status: 400 });
  });

  it.each(['tag', 'author', 'favorited'] as const)(
    'rejects empty or structured %s',
    async (field) => {
      for (const value of [
        '',
        '   ',
        null,
        123,
        [],
        ['valid'],
        {},
        { value: 'valid' },
        '\ud800',
        'x'.repeat(field === 'tag' ? 65 : 51),
      ]) {
        await expect(transform({ [field]: value })).rejects.toMatchObject({
          status: 400,
        });
      }
      if (field !== 'tag')
        await expect(transform({ [field]: 'ab' })).rejects.toMatchObject({
          status: 400,
        });
    },
  );
});
