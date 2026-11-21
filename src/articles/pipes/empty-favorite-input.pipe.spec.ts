import { EmptyFavoriteInputPipe } from './empty-favorite-input.pipe';

describe('EmptyFavoriteInputPipe', () => {
  const pipe = new EmptyFavoriteInputPipe();
  it('accepts omitted bodies and empty objects without deriving an identity', () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform({})).toBeUndefined();
  });
  it.each([
    null,
    [],
    ['value'],
    '',
    'value',
    0,
    true,
    { userId: 'forged' },
    { articleId: 'forged' },
    { article: {} },
    { unknown: true },
  ])('rejects unexpected input (case %#)', (value) => {
    expect(() => pipe.transform(value)).toThrow(
      'Favorite endpoints accept no request fields',
    );
  });
});
