import { ValidationPipe } from '@nestjs/common';
import { COMMENT_BODY_MAX_BYTES } from '../constants/comment.constant';
import { CreateCommentRequestDto } from './create-comment.dto';

describe('CreateCommentRequestDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const transform = (value: unknown): Promise<CreateCommentRequestDto> =>
    pipe.transform(value, { type: 'body', metatype: CreateCommentRequestDto });

  it('preserves meaningful whitespace and line breaks', async () => {
    const body = '  First line\n\n\tSecond line 😀  ';
    expect((await transform({ comment: { body } })).comment.body).toBe(body);
  });

  it.each([
    undefined,
    null,
    [],
    'text',
    123,
    {},
    { comment: undefined },
    { comment: null },
    { comment: [] },
    { comment: [{ body: 'text' }] },
    { comment: 'text' },
    { comment: 1 },
    { comment: true },
    { comment: {} },
    ...[
      undefined,
      null,
      '',
      ' \n\t\r ',
      0,
      true,
      {},
      [],
      ['text'],
      '\ud800',
      '\udc00',
      'text\ud800end',
    ].map((body) => ({ comment: { body } })),
    ...[
      'authorId',
      'articleId',
      'commentId',
      'id',
      'author',
      'createdAt',
      'updatedAt',
      'unknown',
    ].flatMap((field) => [
      { comment: { body: 'text', [field]: 'forged' } },
      { comment: { body: 'text' }, [field]: 'forged' },
    ]),
  ])(
    'rejects malformed input and ownership fields (case %#)',
    async (input) => {
      await expect(transform(input)).rejects.toMatchObject({ status: 400 });
    },
  );

  it.each([
    'a'.repeat(COMMENT_BODY_MAX_BYTES),
    '€'.repeat(21_845),
    '😀'.repeat(16_383) + 'abc',
  ])('accepts exactly 65535 UTF-8 bytes (case %#)', async (body) => {
    expect(Buffer.byteLength(body, 'utf8')).toBe(COMMENT_BODY_MAX_BYTES);
    expect((await transform({ comment: { body } })).comment.body).toBe(body);
  });
  it.each([
    'a'.repeat(COMMENT_BODY_MAX_BYTES + 1),
    '€'.repeat(21_846),
    '😀'.repeat(16_384),
    'a'.repeat(COMMENT_BODY_MAX_BYTES) + ' ',
  ])(
    'rejects excessive UTF-8 bytes including whitespace (case %#)',
    async (body) => {
      await expect(transform({ comment: { body } })).rejects.toMatchObject({
        status: 400,
      });
    },
  );
});
