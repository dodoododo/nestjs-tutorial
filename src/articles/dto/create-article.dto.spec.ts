import { ValidationPipe } from '@nestjs/common';
import { CreateArticleRequestDto } from './create-article.dto';
import { ARTICLE_BODY_MAX_BYTES } from '../constants/article.constant';

describe('CreateArticleRequestDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const valid = {
    title: '  Title  ',
    description: '  Description  ',
    body: '  body\n\n  text  ',
  };
  function transform(value: unknown): Promise<CreateArticleRequestDto> {
    return pipe.transform(value, {
      type: 'body',
      metatype: CreateArticleRequestDto,
    });
  }

  it('trims title/description and preserves body formatting', async () => {
    const result = await transform({ article: valid });
    expect(result.article).toEqual({
      ...valid,
      title: 'Title',
      description: 'Description',
    });
  });

  it('normalizes tags while retaining raw count and invalid values for validation', async () => {
    const result = await transform({
      article: { ...valid, tagList: [' NestJS ', 'NESTJS', 'Tiếng'] },
    });
    expect(result.article.tagList).toEqual(['nestjs', 'nestjs', 'tiếng']);
  });

  it.each([
    {},
    { article: null },
    { article: [] },
    { article: 'text' },
    { article: valid, unknown: true },
    ...['title', 'description', 'body'].flatMap((field) => [
      { article: { ...valid, [field]: undefined } },
      { article: { ...valid, [field]: null } },
      { article: { ...valid, [field]: ' \n\t ' } },
      { article: { ...valid, [field]: 123 } },
      { article: { ...valid, [field]: '\ud800' } },
    ]),
    { article: { ...valid, title: 'a'.repeat(256) } },
    { article: { ...valid, description: 'a'.repeat(1025) } },
    { article: { ...valid, authorId: 'forged' } },
    ...[
      null,
      'tag',
      [1],
      [null],
      [{}],
      [['nested']],
      [' '],
      ['a'.repeat(65)],
      ['\ud800'],
      Array(21).fill('same'),
    ].map((tagList) => ({ article: { ...valid, tagList } })),
  ])('rejects malformed input (case %#)', async (input) => {
    await expect(transform(input)).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    'a'.repeat(ARTICLE_BODY_MAX_BYTES),
    '€'.repeat(21_845),
    '😀'.repeat(16_383) + 'abc',
  ])('accepts exactly 65535 UTF-8 bytes (case %#)', async (body) => {
    expect(Buffer.byteLength(body, 'utf8')).toBe(ARTICLE_BODY_MAX_BYTES);
    expect(
      (await transform({ article: { ...valid, body } })).article.body,
    ).toBe(body);
  });

  it.each(['a'.repeat(65_536), '€'.repeat(21_846), '😀'.repeat(16_384)])(
    'rejects excess UTF-8 bytes (case %#)',
    async (body) => {
      await expect(
        transform({ article: { ...valid, body } }),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
});
