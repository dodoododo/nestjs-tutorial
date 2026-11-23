import { mapComment } from './comment-response.mapper';

describe('mapComment', () => {
  const comment = Object.freeze({
    id: '00000000-0000-4000-8000-000000000001',
    body: '  Body\n\ntext  ',
    createdAt: new Date('2026-01-01T00:00:00.123Z'),
    updatedAt: new Date('2026-01-02T00:00:00.456Z'),
    articleId: 'internal-article',
    authorId: 'internal-author',
    article: { private: true },
  });
  const author = Object.freeze({
    id: 'internal-author',
    username: 'author',
    bio: null,
    image: null,
    email: 'private@example.test',
    passwordHash: 'private-hash',
    token: 'private-token',
  });

  it.each([true, false])(
    'allowlists public fields and uses following metadata %s',
    (following) => {
      expect(mapComment(comment, author, { following })).toEqual({
        id: comment.id,
        body: comment.body,
        createdAt: '2026-01-01T00:00:00.123Z',
        updatedAt: '2026-01-02T00:00:00.456Z',
        author: { username: 'author', bio: null, image: null, following },
      });
    },
  );
  it('preserves populated public profile values without mutating inputs', () => {
    const profile = Object.freeze({
      ...author,
      bio: 'Biography',
      image: '/avatar.png',
    });
    const mapped = mapComment(comment, profile, { following: true });
    expect(mapped.author).toEqual({
      username: 'author',
      bio: 'Biography',
      image: '/avatar.png',
      following: true,
    });
    mapped.body = 'Changed response';
    mapped.author.username = 'Changed response';
    expect(comment.body).toBe('  Body\n\ntext  ');
    expect(profile.username).toBe('author');
  });
});
