import { articleSlug } from './article-slug.util';
import { ARTICLE_SLUG_MAX_LENGTH } from '../constants/article.constant';

describe('articleSlug', () => {
  it.each([
    ['Hello World', 'hello-world'],
    [' How to train your dragon! ', 'how-to-train-your-dragon'],
    ['\u0110\u01b0\u1eddng \u0111\u1ebfn Vi\u1ec7t Nam', 'duong-den-viet-nam'],
    ['Tie\u0302\u0301ng Vie\u0323\u0302t', 'tieng-viet'],
    ['\u4e2d\u6587 \u65e5\u672c\u8a9e', '\u4e2d\u6587-\u65e5\u672c\u8a9e'],
    ['\u{1f525}?!', 'article'],
    ['', 'article'],
    ['a---b', 'a-b'],
  ])(
    'preserves readable normalization with a random suffix (case %#)',
    (title, expected) => {
      expect(articleSlug(title)).toMatch(
        new RegExp(`^${expected}-[0-9a-f]{12}$`, 'u'),
      );
    },
  );

  it.each(['feed', 'FEED', 'F\u00e9\u00e9d', '\uff26\uff25\uff25\uff24'])(
    'makes reserved-looking title %s routable',
    (title) => {
      expect(articleSlug(title)).toMatch(/^feed-[0-9a-f]{12}$/);
    },
  );

  it.each([
    'a'.repeat(255),
    '\ufb03'.repeat(255),
    '\u{10400}'.repeat(255),
    'a'.repeat(241) + ' - b',
  ])('reserves suffix space without splitting Unicode (case %#)', (title) => {
    const slug = articleSlug(title);
    expect(slug.length).toBeLessThanOrEqual(ARTICLE_SLUG_MAX_LENGTH);
    expect(slug).not.toMatch(/\p{Surrogate}/u);
    expect(slug).toMatch(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*-[0-9a-f]{12}$/u);
    expect(decodeURIComponent(encodeURIComponent(slug))).toBe(slug);
  });

  it('uses all available ASCII space', () => {
    expect(articleSlug('a'.repeat(255))).toMatch(
      new RegExp(`^a{242}-[0-9a-f]{12}$`),
    );
  });

  it('gives equal and accent-equivalent titles independent random suffixes', () => {
    const first = articleSlug('\u0110\u01b0\u1eddng \u0111i');
    const second = articleSlug('DUONG DI!');
    expect(first).toMatch(/^duong-di-[0-9a-f]{12}$/);
    expect(second).toMatch(/^duong-di-[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
    expect(articleSlug('DUONG DI!')).not.toBe(second);
  });
});
