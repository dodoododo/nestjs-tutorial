import { ValidationPipe } from '@nestjs/common';
import { FeedArticlesQueryDto } from './feed-articles-query.dto';

describe('FeedArticlesQueryDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  function transform(value: unknown): Promise<FeedArticlesQueryDto> {
    return pipe.transform(value, {
      type: 'query',
      metatype: FeedArticlesQueryDto,
    });
  }

  it('inherits only pagination defaults and accepts the documented bounds', async () => {
    expect(await transform({})).toEqual({ limit: 20, offset: 0 });
    expect(
      await transform({ limit: '100', offset: '9007199254740991' }),
    ).toEqual({ limit: 100, offset: Number.MAX_SAFE_INTEGER });
    expect(await transform({ limit: '01', offset: '00' })).toEqual({
      limit: 1,
      offset: 0,
    });
  });

  it.each(['limit', 'offset'] as const)(
    'inherits strict parsing for %s',
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
        'NaN',
        'Infinity',
        '1x',
        '9007199254740992',
        '9'.repeat(400),
        ['1'],
        ['1', '2'],
        {},
        { value: '1' },
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
    { tag: 'nestjs' },
    { author: 'jacob' },
    { favorited: 'alice' },
    { viewerId: 'forged' },
    { unknown: 'x' },
    { 'limit[]': '1' },
    { 'offset[value]': '0' },
  ])('rejects unsupported or out-of-policy input (case %#)', async (value) => {
    await expect(transform(value)).rejects.toMatchObject({ status: 400 });
  });
});
