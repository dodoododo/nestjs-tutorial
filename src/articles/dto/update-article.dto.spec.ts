import { ValidationPipe } from '@nestjs/common';
import { CreateArticleRequestDto } from './create-article.dto';
import { UpdateArticleRequestDto } from './update-article.dto';

describe('UpdateArticleRequestDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  function transform(value: unknown): Promise<UpdateArticleRequestDto> {
    return pipe.transform(value, {
      type: 'body',
      metatype: UpdateArticleRequestDto,
    });
  }

  it('accepts an empty object and individual optional fields', async () => {
    expect((await transform({ article: {} })).article).toEqual({});
    expect(
      (await transform({ article: { title: '  Title  ' } })).article,
    ).toEqual({ title: 'Title' });
    expect(
      (await transform({ article: { description: '  Description  ' } }))
        .article,
    ).toEqual({ description: 'Description' });
    expect(
      (await transform({ article: { body: '  Body\n\n  content  ' } })).article,
    ).toEqual({ body: '  Body\n\n  content  ' });
  });

  it.each([
    {},
    { article: undefined },
    { article: null },
    { article: [] },
    { article: [{}] },
    { article: 'text' },
    { article: 42 },
    { article: {}, unexpected: true },
    ...[
      'authorId',
      'author',
      'id',
      'slug',
      'createdAt',
      'updatedAt',
      'tagList',
      'unknown',
    ].map((field) => ({ article: { [field]: 'forged' } })),
  ])(
    'rejects invalid envelopes and unknown fields (case %#)',
    async (value) => {
      await expect(transform(value)).rejects.toMatchObject({ status: 400 });
    },
  );

  it.each(['title', 'description', 'body'] as const)(
    'shares Create validation for %s, including rejecting null',
    async (field) => {
      for (const value of [null, 123, [], {}, '', ' \n\t ', '\ud800']) {
        const invalid = { [field]: value };
        await expect(transform({ article: invalid })).rejects.toMatchObject({
          status: 400,
        });
        await expect(
          pipe.transform(
            {
              article: {
                title: 'Title',
                description: 'Description',
                body: 'Body',
                ...invalid,
              },
            },
            { type: 'body', metatype: CreateArticleRequestDto },
          ),
        ).rejects.toMatchObject({ status: 400 });
      }
    },
  );

  it.each([
    { title: 'a'.repeat(256) },
    { description: 'a'.repeat(1025) },
    { body: 'a'.repeat(65_536) },
    { body: '€'.repeat(21_846) },
    { body: '😀'.repeat(16_384) },
  ])('rejects database length violations (case %#)', async (article) => {
    await expect(transform({ article })).rejects.toMatchObject({ status: 400 });
  });

  it('validates lengths after trimming', async () => {
    const title = 'a'.repeat(255);
    const description = 'a'.repeat(1024);
    const result = await transform({
      article: { title: ` ${title} `, description: ` ${description} ` },
    });
    expect(result.article).toEqual({ title, description });
  });

  it.each([
    'a'.repeat(65_535),
    '€'.repeat(21_845),
    '😀'.repeat(16_383) + 'abc',
  ])('accepts the exact UTF-8 byte boundary (case %#)', async (body) => {
    expect((await transform({ article: { body } })).article.body).toBe(body);
  });
});
