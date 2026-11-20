import { mapArticle } from './article-response.mapper';

describe('mapArticle', () => {
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
