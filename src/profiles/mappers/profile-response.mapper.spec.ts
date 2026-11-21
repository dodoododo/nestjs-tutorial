import { mapProfile } from './profile-response.mapper';

describe('mapProfile', () => {
  it.each([
    [false, null, null],
    [true, null, null],
    [false, 'Biography', '/avatar.png'],
    [true, 'Biography', '/avatar.png'],
  ] as const)('maps only public fields (case %#)', (following, bio, image) => {
    const user = Object.freeze({
      username: 'alice',
      bio,
      image,
      id: 'private-id',
      email: 'private@example.test',
      passwordHash: 'private-hash',
      role: 'private-role',
      token: 'private-token',
    });
    expect(mapProfile(user, following)).toEqual({
      username: 'alice',
      bio,
      image,
      following,
    });
  });

  it('returns independent responses without mutating a frozen projection', () => {
    const user = Object.freeze({
      username: 'alice',
      bio: 'Biography',
      image: '/avatar.png',
    });
    const first = mapProfile(user, true);
    const second = mapProfile(user, false);
    first.username = 'Changed response';
    expect(second).toEqual({ ...user, following: false });
    expect(user.username).toBe('alice');
  });
});
