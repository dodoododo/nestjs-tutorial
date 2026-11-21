import { mapArticle, mapArticleSummary } from './article-response.mapper';

describe('mapArticle', () => {
  it.each([true, false])(
    'preserves populated author profiles for full and summary responses with following=%s',
    (following) => {
      const loaded = Object.freeze({
        slug: 'title',
        title: 'Title',
        description: 'Description',
        body: 'Body',
        createdAt: new Date('2026-01-01T00:00:00.123Z'),
        updatedAt: new Date('2026-01-01T00:00:00.123Z'),
        author: Object.freeze({
          username: 'author',
          bio: 'Biography',
          image: '/avatar.png',
          id: 'private',
          email: 'private@example.test',
          passwordHash: 'private',
          role: 'private',
          token: 'private',
        }),
      });
      const metadata = {
        tagList: [],
        favoritesCount: 0,
        favorited: false,
        following,
      };
      for (const mapper of [mapArticle, mapArticleSummary]) {
        expect(mapper(loaded, metadata).author).toEqual({
          username: 'author',
          bio: 'Biography',
          image: '/avatar.png',
          following,
        });
      }
    },
  );

  it('allowlists public fields, converts timestamps and does not mutate inputs', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const loaded = {
      id: 'private',
      slug: 'title',
      title: 'Title',
      description: 'Description',
      body: 'Body',
      createdAt: date,
      updatedAt: date,
      authorId: 'private-author',
      author: {
        id: 'private-author',
        username: 'author',
        bio: null,
        image: null,
        email: 'private@example.test',
        passwordHash: 'private',
      },
    };
    const metadata = {
      tagList: ['nestjs'],
      favoritesCount: 2,
      favorited: true,
      following: true,
    };
    const result = mapArticle(loaded, metadata);
    const summary = mapArticleSummary(loaded, metadata);
    const { body: _body, ...expectedSummary } = result;
    expect(summary).toEqual(expectedSummary);
    expect(summary).not.toHaveProperty('body');
    summary.tagList.push('summary-only');
    expect(metadata.tagList).toEqual(['nestjs']);
    expect(result).toEqual({
      slug: 'title',
      title: 'Title',
      description: 'Description',
      body: 'Body',
      tagList: ['nestjs'],
      createdAt: date.toISOString(),
      updatedAt: date.toISOString(),
      favorited: true,
      favoritesCount: 2,
      author: { username: 'author', bio: null, image: null, following: true },
    });
    result.tagList.push('other');
    expect(metadata.tagList).toEqual(['nestjs']);
  });
});
