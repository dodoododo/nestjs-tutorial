import { I18nService } from 'nestjs-i18n';
import { EmptyFavoriteInputPipe } from './empty-favorite-input.pipe';

describe('EmptyFavoriteInputPipe', () => {
  const i18n = { t: jest.fn(() => 'Localized favorite validation') };
  const pipe = new EmptyFavoriteInputPipe(i18n as unknown as I18nService);
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
      'Localized favorite validation',
    );
    expect(i18n.t).toHaveBeenCalledWith('articles.FAVORITE_INPUT_NOT_EMPTY');
  });
});
