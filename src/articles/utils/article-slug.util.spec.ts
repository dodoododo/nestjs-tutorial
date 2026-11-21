import { articleSlug } from './article-slug.util';

describe('articleSlug', () => {
  it.each([
    [' How to train your dragon! ', 'how-to-train-your-dragon'],
    ['Đường đến Việt Nam', 'duong-den-viet-nam'],
    ['Tiếng Việt', 'tieng-viet'],
    ['中文 日本語', '中文-日本語'],
    ['🔥?!', 'article'],
    ['', 'article'],
    ['a---b', 'a-b'],
  ])('normalizes %j to %j', (title, expected) => {
    expect(articleSlug(title)).toBe(expected);
  });

  it('bounds expanded Unicode slugs and removes trailing separators', () => {
    expect(articleSlug('ﬃ'.repeat(255))).toHaveLength(255);
    expect(articleSlug('a'.repeat(254) + ' - b')).toBe('a'.repeat(254));
  });

  it('gives equivalent titles the same slug for database conflict detection', () => {
    expect(articleSlug('Đường đi')).toBe(articleSlug('DUONG DI!'));
  });
});
